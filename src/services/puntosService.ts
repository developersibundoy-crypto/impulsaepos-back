import pool from "../conection";

// ─── CONSTANTES ─────────────────────────────────────────────────────────────────
const DEFAULT_PCT_ACUMULACION = 2.00;
const DEFAULT_PCT_REDENCION_MAX = 20.00;
const DEFAULT_VIGENCIA_DIAS = 90;
const DEFAULT_MONTO_MIN_ACUMULAR = 100;
const DEFAULT_MONTO_MIN_REDIMIR = 500;
const DEFAULT_VALOR_PUNTO = 1;

// ─── TIPOS INTERNOS ─────────────────────────────────────────────────────────────
interface ConfigBasica {
  activo: boolean;
  porcentaje_acumulacion: number;
  porcentaje_redencion_max: number;
  vigencia_dias: number;
  monto_minimo_acumular: number;
  monto_minimo_redimir: number;
  valor_punto: number;
  modo_acumulacion: "porcentaje" | "cada_x";
  puntos_por_cada: number;
  monto_para_cada: number;
}

interface NivelCliente {
  id?: number;
  nombre: string;
  nivel: number;
  porcentaje_acumulacion: number;
  porcentaje_redencion_max: number;
  vigencia_dias: number;
  monto_minimo_acumular: number;
  monto_minimo_redimir: number;
  multiplicador_base: number;
  activo: boolean;
}

interface Campania {
  id?: number;
  nombre: string;
  tipo: "multiplicador" | "puntos_fijos" | "descuento";
  multiplicador: number;
  puntos_fijos_por_cada: number | null;
  monto_para_puntos_fijos: number | null;
  nivel_cliente_id: number | null;
  producto_id: number | null;
  categoria: string | null;
  marca: string | null;
  fecha_inicio: string;
  fecha_fin: string;
  activo: boolean;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────────

async function tablaExiste(nombre: string): Promise<boolean> {
  try {
    const [rows]: any = await pool.promise().query(
      "SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
      [nombre]
    );
    return rows[0].cnt > 0;
  } catch {
    return false;
  }
}

async function columnaExiste(tabla: string, columna: string): Promise<boolean> {
  try {
    const [rows]: any = await pool.promise().query(
      "SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
      [tabla, columna]
    );
    return rows[0].cnt > 0;
  } catch {
    return false;
  }
}

// ─── OBTENER CONFIGURACIÓN COMPLETA ─────────────────────────────────────────────

async function getConfig(empresaId: number): Promise<{ basica: ConfigBasica; niveles: NivelCliente[]; tieneNiveles: boolean; tieneCampanias: boolean }> {
  const [rows]: any = await pool.promise().query(
    "SELECT * FROM config_fidelizacion WHERE empresa_id = ?",
    [empresaId]
  );

  const tieneNiveles = await tablaExiste("niveles_cliente");
  const tieneCampanias = await tablaExiste("campanias_puntos");

  let niveles: NivelCliente[] = [];
  if (tieneNiveles) {
    const [nivelesRows]: any = await pool.promise().query(
      "SELECT * FROM niveles_cliente WHERE empresa_id = ? AND activo = 1 ORDER BY nivel ASC",
      [empresaId]
    );
    niveles = nivelesRows;
  }

  if (rows.length === 0) {
    return {
      basica: {
        activo: false,
        porcentaje_acumulacion: DEFAULT_PCT_ACUMULACION,
        porcentaje_redencion_max: DEFAULT_PCT_REDENCION_MAX,
        vigencia_dias: DEFAULT_VIGENCIA_DIAS,
        monto_minimo_acumular: DEFAULT_MONTO_MIN_ACUMULAR,
        monto_minimo_redimir: DEFAULT_MONTO_MIN_REDIMIR,
        valor_punto: DEFAULT_VALOR_PUNTO,
        modo_acumulacion: "porcentaje",
        puntos_por_cada: 1,
        monto_para_cada: 50,
      },
      niveles,
      tieneNiveles,
      tieneCampanias,
    };
  }

  const r = rows[0];
  return {
    basica: {
      activo: !!r.activo,
      porcentaje_acumulacion: parseFloat(r.porcentaje_acumulacion ?? r.puntos_por_compra ?? DEFAULT_PCT_ACUMULACION),
      porcentaje_redencion_max: parseFloat(r.porcentaje_redencion_max ?? DEFAULT_PCT_REDENCION_MAX),
      vigencia_dias: parseInt(r.vigencia_dias ?? DEFAULT_VIGENCIA_DIAS),
      monto_minimo_acumular: parseFloat(r.monto_minimo_acumular ?? DEFAULT_MONTO_MIN_ACUMULAR),
      monto_minimo_redimir: parseFloat(r.monto_minimo_redimir ?? DEFAULT_MONTO_MIN_REDIMIR),
      valor_punto: parseFloat(r.valor_punto ?? DEFAULT_VALOR_PUNTO),
      modo_acumulacion: r.modo_acumulacion ?? "porcentaje",
      puntos_por_cada: parseInt(r.puntos_por_cada ?? 1),
      monto_para_cada: parseFloat(r.monto_para_cada ?? 50),
    },
    niveles,
    tieneNiveles,
    tieneCampanias,
  };
}

// ─── GUARDAR CONFIGURACIÓN ───────────────────────────────────────────────────────

async function saveConfig(empresaId: number, data: Partial<ConfigBasica>): Promise<void> {
  const [existing]: any = await pool.promise().query(
    "SELECT id FROM config_fidelizacion WHERE empresa_id = ?",
    [empresaId]
  );

  const fields = {
    activo: data.activo !== undefined ? (data.activo ? 1 : 0) : 1,
    porcentaje_acumulacion: data.porcentaje_acumulacion ?? DEFAULT_PCT_ACUMULACION,
    porcentaje_redencion_max: data.porcentaje_redencion_max ?? DEFAULT_PCT_REDENCION_MAX,
    vigencia_dias: data.vigencia_dias ?? DEFAULT_VIGENCIA_DIAS,
    monto_minimo_acumular: data.monto_minimo_acumular ?? DEFAULT_MONTO_MIN_ACUMULAR,
    monto_minimo_redimir: data.monto_minimo_redimir ?? DEFAULT_MONTO_MIN_REDIMIR,
    valor_punto: data.valor_punto ?? DEFAULT_VALOR_PUNTO,
    modo_acumulacion: data.modo_acumulacion ?? "porcentaje",
    puntos_por_cada: data.puntos_por_cada ?? 1,
    monto_para_cada: data.monto_para_cada ?? 50,
  };

  // Detectar si la tabla tiene las columnas nuevas
  const tieneColsNuevas = await columnaExiste("config_fidelizacion", "porcentaje_acumulacion");

  if (existing.length > 0) {
    const id = existing[0].id;
    if (tieneColsNuevas) {
      await pool.promise().query(
        `UPDATE config_fidelizacion SET
          activo = ?, porcentaje_acumulacion = ?, porcentaje_redencion_max = ?,
          vigencia_dias = ?, monto_minimo_acumular = ?, monto_minimo_redimir = ?,
          valor_punto = ?, modo_acumulacion = ?, puntos_por_cada = ?, monto_para_cada = ?
        WHERE id = ?`,
        [
          fields.activo, fields.porcentaje_acumulacion, fields.porcentaje_redencion_max,
          fields.vigencia_dias, fields.monto_minimo_acumular, fields.monto_minimo_redimir,
          fields.valor_punto, fields.modo_acumulacion, fields.puntos_por_cada, fields.monto_para_cada,
          id,
        ]
      );
    } else {
      await pool.promise().query(
        `UPDATE config_fidelizacion SET activo = ? WHERE id = ?`,
        [fields.activo, id]
      );
    }
  } else {
    if (tieneColsNuevas) {
      await pool.promise().query(
        `INSERT INTO config_fidelizacion
          (empresa_id, activo, porcentaje_acumulacion, porcentaje_redencion_max,
           vigencia_dias, monto_minimo_acumular, monto_minimo_redimir,
           valor_punto, modo_acumulacion, puntos_por_cada, monto_para_cada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          empresaId,
          fields.activo, fields.porcentaje_acumulacion, fields.porcentaje_redencion_max,
          fields.vigencia_dias, fields.monto_minimo_acumular, fields.monto_minimo_redimir,
          fields.valor_punto, fields.modo_acumulacion, fields.puntos_por_cada, fields.monto_para_cada,
        ]
      );
    } else {
      await pool.promise().query(
        `INSERT INTO config_fidelizacion (empresa_id, activo) VALUES (?, ?)`,
        [empresaId, fields.activo]
      );
    }
  }
}

// ─── NIVELES ─────────────────────────────────────────────────────────────────────

async function getNiveles(empresaId: number): Promise<NivelCliente[]> {
  if (!(await tablaExiste("niveles_cliente"))) return [];
  const [rows]: any = await pool.promise().query(
    "SELECT * FROM niveles_cliente WHERE empresa_id = ? ORDER BY nivel ASC",
    [empresaId]
  );
  return rows;
}

async function saveNivel(empresaId: number, data: NivelCliente): Promise<void> {
  if (!(await tablaExiste("niveles_cliente"))) {
    throw new Error("La tabla niveles_cliente no existe. Ejecuta la migración primero.");
  }
  if (data.id) {
    await pool.promise().query(
      `UPDATE niveles_cliente SET
        nombre = ?, nivel = ?, porcentaje_acumulacion = ?, porcentaje_redencion_max = ?,
        vigencia_dias = ?, monto_minimo_acumular = ?, monto_minimo_redimir = ?,
        multiplicador_base = ?, activo = ?
      WHERE id = ? AND empresa_id = ?`,
      [
        data.nombre, data.nivel, data.porcentaje_acumulacion, data.porcentaje_redencion_max,
        data.vigencia_dias, data.monto_minimo_acumular, data.monto_minimo_redimir,
        data.multiplicador_base, data.activo ? 1 : 0,
        data.id, empresaId,
      ]
    );
  } else {
    await pool.promise().query(
      `INSERT INTO niveles_cliente
        (empresa_id, nombre, nivel, porcentaje_acumulacion, porcentaje_redencion_max,
         vigencia_dias, monto_minimo_acumular, monto_minimo_redimir, multiplicador_base, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        empresaId, data.nombre, data.nivel, data.porcentaje_acumulacion, data.porcentaje_redencion_max,
        data.vigencia_dias, data.monto_minimo_acumular, data.monto_minimo_redimir,
        data.multiplicador_base, data.activo ? 1 : 0,
      ]
    );
  }
}

async function deleteNivel(empresaId: number, id: number): Promise<void> {
  if (!(await tablaExiste("niveles_cliente"))) return;
  await pool.promise().query(
    "DELETE FROM niveles_cliente WHERE id = ? AND empresa_id = ?",
    [id, empresaId]
  );
}

// ─── CAMPAÑAS ────────────────────────────────────────────────────────────────────

async function getCampanias(empresaId: number): Promise<Campania[]> {
  if (!(await tablaExiste("campanias_puntos"))) return [];
  const [rows]: any = await pool.promise().query(
    "SELECT * FROM campanias_puntos WHERE empresa_id = ? ORDER BY fecha_inicio DESC",
    [empresaId]
  );
  return rows;
}

async function saveCampania(empresaId: number, data: Campania): Promise<void> {
  if (!(await tablaExiste("campanias_puntos"))) {
    throw new Error("La tabla campanias_puntos no existe. Ejecuta la migración primero.");
  }
  if (data.id) {
    await pool.promise().query(
      `UPDATE campanias_puntos SET
        nombre = ?, tipo = ?, multiplicador = ?, puntos_fijos_por_cada = ?,
        monto_para_puntos_fijos = ?, nivel_cliente_id = ?, producto_id = ?,
        categoria = ?, marca = ?, fecha_inicio = ?, fecha_fin = ?, activo = ?
      WHERE id = ? AND empresa_id = ?`,
      [
        data.nombre, data.tipo, data.multiplicador, data.puntos_fijos_por_cada,
        data.monto_para_puntos_fijos, data.nivel_cliente_id, data.producto_id,
        data.categoria, data.marca, data.fecha_inicio, data.fecha_fin, data.activo ? 1 : 0,
        data.id, empresaId,
      ]
    );
  } else {
    await pool.promise().query(
      `INSERT INTO campanias_puntos
        (empresa_id, nombre, tipo, multiplicador, puntos_fijos_por_cada,
         monto_para_puntos_fijos, nivel_cliente_id, producto_id,
         categoria, marca, fecha_inicio, fecha_fin, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        empresaId, data.nombre, data.tipo, data.multiplicador, data.puntos_fijos_por_cada,
        data.monto_para_puntos_fijos, data.nivel_cliente_id, data.producto_id,
        data.categoria, data.marca, data.fecha_inicio, data.fecha_fin, data.activo ? 1 : 0,
      ]
    );
  }
}

async function deleteCampania(empresaId: number, id: number): Promise<void> {
  if (!(await tablaExiste("campanias_puntos"))) return;
  await pool.promise().query(
    "DELETE FROM campanias_puntos WHERE id = ? AND empresa_id = ?",
    [id, empresaId]
  );
}

// ─── CALCULAR PUNTOS ─────────────────────────────────────────────────────────────

async function calcularPuntosAcumular(
  empresaId: number,
  clienteId: number,
  totalVenta: number,
  items: any[]
): Promise<{ puntos: number; porcentajeAplicado: number; multiplicadorAplicado: number; campaniaId: number | null }> {
  const config = await getConfig(empresaId);
  if (!config.basica.activo) return { puntos: 0, porcentajeAplicado: 0, multiplicadorAplicado: 1, campaniaId: null };

  if (totalVenta < config.basica.monto_minimo_acumular) return { puntos: 0, porcentajeAplicado: 0, multiplicadorAplicado: 1, campaniaId: null };

  // 1. Determinar % base según nivel del cliente
  let pctBase = config.basica.porcentaje_acumulacion;
  let multiplicador = 1;

  if (config.tieneNiveles && config.niveles.length > 0) {
    const tieneNivelCol = await columnaExiste("clientes", "nivel_cliente_id");
    if (tieneNivelCol) {
      const [cliRow]: any = await pool.promise().query(
        "SELECT nivel_cliente_id FROM clientes WHERE id = ?",
        [clienteId]
      );
      if (cliRow.length > 0 && cliRow[0].nivel_cliente_id) {
        const nivel = config.niveles.find((n: any) => n.id === cliRow[0].nivel_cliente_id);
        if (nivel) {
          pctBase = Number(nivel.porcentaje_acumulacion) || pctBase;
          multiplicador = Number(nivel.multiplicador_base) || 1;
        }
      }
    }
  }

  // 2. Buscar campañas activas que apliquen
  let campaniaId: number | null = null;
  if (config.tieneCampanias) {
    const [campanias]: any = await pool.promise().query(
      `SELECT * FROM campanias_puntos
       WHERE empresa_id = ? AND activo = 1
         AND fecha_inicio <= CURDATE() AND fecha_fin >= CURDATE()
       ORDER BY multiplicador DESC LIMIT 1`,
      [empresaId]
    );
    if (campanias.length > 0) {
      const c = campanias[0];
      campaniaId = c.id;
      if (c.tipo === "multiplicador") {
        multiplicador *= parseFloat(c.multiplicador) || 1;
      } else if (c.tipo === "puntos_fijos" && c.monto_para_puntos_fijos) {
        // Modo puntos fijos: obvia el porcentaje
        const puntosFijos = Math.floor(totalVenta / parseFloat(c.monto_para_puntos_fijos)) * (parseInt(c.puntos_fijos_por_cada) || 1);
        return { puntos: puntosFijos, porcentajeAplicado: 0, multiplicadorAplicado: 1, campaniaId };
      }
    }
  }

  // 3. Calcular puntos según modo
  let puntos: number;
  if (config.basica.modo_acumulacion === "cada_x" && config.basica.monto_para_cada > 0) {
    puntos = Math.floor(totalVenta / config.basica.monto_para_cada) * config.basica.puntos_por_cada;
  } else {
    puntos = Math.floor(totalVenta * (pctBase / 100));
  }

  puntos = Math.floor(puntos * multiplicador);

  return { puntos, porcentajeAplicado: pctBase, multiplicadorAplicado: multiplicador, campaniaId };
}

// ─── ACUMULAR PUNTOS ─────────────────────────────────────────────────────────────

async function acumular(
  empresaId: number,
  clienteId: number,
  totalVenta: number,
  items: any[],
  facturaId: number | null,
  facturaTipo: string,
  io?: any
): Promise<{
  puntos_ganados: number;
  puntos_totales: number;
  puntos_redimidos: number;
  descuento_aplicado: number;
  descuento_puntos: number;
  saldo_restante: number;
  campania_id: number | null;
} | null> {
  const config = await getConfig(empresaId);
  if (!config.basica.activo) return null;

  const result = await calcularPuntosAcumular(empresaId, clienteId, totalVenta, items);
  if (result.puntos <= 0) return null;

  const promisePool = pool.promise();
  let conn;
  try {
    conn = await promisePool.getConnection();
    await conn.beginTransaction();

    // Saldo actual
    const [cliRow]: any = await conn.query(
      "SELECT puntos_acumulados, total_puntos_ganados, total_compras, total_gastado FROM clientes WHERE id = ? FOR UPDATE",
      [clienteId]
    );
    if (cliRow.length === 0) { await conn.rollback(); return null; }

    const saldoActual = parseInt(cliRow[0].puntos_acumulados) || 0;
    const nuevoSaldo = saldoActual + result.puntos;

    const tieneLotes = await tablaExiste("lotes_puntos");
    const tieneMovimientos = await tablaExiste("movimientos_puntos");
    const tieneColumnasExtra = await columnaExiste("clientes", "total_puntos_ganados");

    // Crear lote si existe tabla
    let loteId: number | null = null;
    if (tieneLotes) {
      const fechaVenc = new Date();
      fechaVenc.setDate(fechaVenc.getDate() + config.basica.vigencia_dias);
      const loteRes: any = await conn.query(
        `INSERT INTO lotes_puntos
          (empresa_id, cliente_id, factura_id, factura_tipo, puntos_generados, puntos_disponibles, fecha_vencimiento, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVO')`,
        [empresaId, clienteId, facturaId, facturaTipo, result.puntos, result.puntos, fechaVenc.toISOString().split("T")[0]]
      );
      loteId = loteRes[0].insertId;
    }

    // Registrar movimiento
    if (tieneMovimientos) {
      await conn.query(
        `INSERT INTO movimientos_puntos
          (empresa_id, cliente_id, lote_id, tipo_movimiento, puntos, saldo_anterior, saldo_posterior, referencia_id, referencia_tipo, descripcion)
         VALUES (?, ?, ?, 'GENERACION', ?, ?, ?, ?, 'factura', ?)`,
        [empresaId, clienteId, loteId, result.puntos, saldoActual, nuevoSaldo, facturaId,
         `Venta ${facturaTipo} #${facturaId}: ${result.puntos} pts (${result.porcentajeAplicado}% × ${result.multiplicadorAplicado}x)`
        ]
      );
    }

    // Actualizar cliente
    if (tieneColumnasExtra) {
      await conn.query(
        `UPDATE clientes SET
          puntos_acumulados = ?,
          total_puntos_ganados = COALESCE(total_puntos_ganados, 0) + ?,
          total_compras = COALESCE(total_compras, 0) + 1,
          total_gastado = COALESCE(total_gastado, 0) + ?
        WHERE id = ?`,
        [nuevoSaldo, result.puntos, totalVenta, clienteId]
      );
    } else {
      await conn.query(
        "UPDATE clientes SET puntos_acumulados = ? WHERE id = ?",
        [nuevoSaldo, clienteId]
      );
    }

    // Registrar también en historial_puntos (old table) por compatibilidad
    const [oldHistRows]: any = await conn.query(
      "SELECT puntos_acumulados FROM clientes WHERE id = ?",
      [clienteId]
    );
    const saldoFinal = parseInt(oldHistRows[0]?.puntos_acumulados) || nuevoSaldo;
    await conn.query(
      `INSERT INTO historial_puntos
        (empresa_id, cliente_id, factura_id, factura_tipo, puntos_ganados, puntos_antes, puntos_despues, total_venta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [empresaId, clienteId, facturaId, facturaTipo, result.puntos, saldoActual, saldoFinal, totalVenta]
    );

    await conn.commit();

    // Emitir Socket.io
    if (io) {
      io.to(`empresa_${empresaId}`).emit("puntos_actualizados", {
        cliente_id: clienteId,
        puntos: saldoFinal,
        puntos_ganados: result.puntos,
        campania_id: result.campaniaId,
      });
    }

    return {
      puntos_ganados: result.puntos,
      puntos_totales: saldoFinal,
      puntos_redimidos: 0,
      descuento_aplicado: 0,
      descuento_puntos: 0,
      saldo_restante: saldoFinal,
      campania_id: result.campaniaId,
    };
  } catch (err) {
    if (conn) await conn.rollback();
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// ─── REDIMIR PUNTOS ──────────────────────────────────────────────────────────────

async function redimir(
  empresaId: number,
  clienteId: number,
  totalVenta: number,
  puntosSolicitados: number,
  cajeroId: number | null,
  facturaId?: number | null,
  io?: any
): Promise<{
  puntos_redimidos: number;
  descuento: number;
  saldo_restante: number;
} | null> {
  const config = await getConfig(empresaId);
  if (!config.basica.activo) return null;

  if (totalVenta < config.basica.monto_minimo_redimir) {
    throw new Error(`El monto mínimo para redimir puntos es $${config.basica.monto_minimo_redimir.toLocaleString("es-CO")}`);
  }

  // Calcular máximo a redimir según % del total
  const maxPuntosRedimir = Math.floor(totalVenta * (config.basica.porcentaje_redencion_max / 100));
  if (puntosSolicitados > maxPuntosRedimir) {
    throw new Error(`Solo puedes redimir hasta ${maxPuntosRedimir} puntos (${config.basica.porcentaje_redencion_max}% de la compra)`);
  }

  const promisePool = pool.promise();
  let conn;
  try {
    conn = await promisePool.getConnection();
    await conn.beginTransaction();

    // Saldo actual del cliente
    const [cliRow]: any = await conn.query(
      "SELECT puntos_acumulados FROM clientes WHERE id = ? AND empresa_id = ? FOR UPDATE",
      [clienteId, empresaId]
    );
    if (cliRow.length === 0) throw new Error("Cliente no encontrado");

    const saldoActual = parseInt(cliRow[0].puntos_acumulados) || 0;
    if (puntosSolicitados > saldoActual) {
      throw new Error(`Puntos insuficientes. Tienes ${saldoActual} puntos.`);
    }

    const tieneLotes = await tablaExiste("lotes_puntos");
    const tieneMovimientos = await tablaExiste("movimientos_puntos");
    const valorPunto = config.basica.valor_punto || 1;
    const descuento = puntosSolicitados * valorPunto;
    const nuevoSaldo = saldoActual - puntosSolicitados;

    // Consumir lotes FIFO (primeros en vencer)
    if (tieneLotes) {
      const [lotes]: any = await conn.query(
        `SELECT id, puntos_disponibles FROM lotes_puntos
         WHERE empresa_id = ? AND cliente_id = ? AND estado = 'ACTIVO' AND puntos_disponibles > 0
         ORDER BY fecha_vencimiento ASC FOR UPDATE`,
        [empresaId, clienteId]
      );

      let pendiente = puntosSolicitados;
      for (const lote of lotes) {
        if (pendiente <= 0) break;
        const consumir = Math.min(pendiente, lote.puntos_disponibles);
        await conn.query(
          "UPDATE lotes_puntos SET puntos_disponibles = puntos_disponibles - ? WHERE id = ?",
          [consumir, lote.id]
        );
        pendiente -= consumir;
      }
    }

    // Registrar movimiento
    if (tieneMovimientos) {
      await conn.query(
        `INSERT INTO movimientos_puntos
          (empresa_id, cliente_id, tipo_movimiento, puntos, saldo_anterior, saldo_posterior, referencia_id, referencia_tipo, descripcion, cajero_id)
         VALUES (?, ?, 'REDENCION', ?, ?, ?, ?, 'factura', ?, ?)`,
        [empresaId, clienteId, -puntosSolicitados, saldoActual, nuevoSaldo, facturaId,
         `Redención: ${puntosSolicitados} pts = $${descuento.toLocaleString("es-CO")}`, cajeroId]
      );
    }

    // Actualizar saldo
    const tieneColsExtra = await columnaExiste("clientes", "total_puntos_redimidos");
    if (tieneColsExtra) {
      await conn.query(
        `UPDATE clientes SET
          puntos_acumulados = ?,
          total_puntos_redimidos = COALESCE(total_puntos_redimidos, 0) + ?
        WHERE id = ?`,
        [nuevoSaldo, puntosSolicitados, clienteId]
      );
    } else {
      await conn.query(
        "UPDATE clientes SET puntos_acumulados = ? WHERE id = ?",
        [nuevoSaldo, clienteId]
      );
    }

    // Registrar en old historial_puntos (como puntos negativos)
    const [oldHistRows]: any = await conn.query(
      "SELECT puntos_acumulados FROM clientes WHERE id = ?",
      [clienteId]
    );
    const saldoFinal = parseInt(oldHistRows[0]?.puntos_acumulados) || nuevoSaldo;
    await conn.query(
      `INSERT INTO historial_puntos
        (empresa_id, cliente_id, factura_id, factura_tipo, puntos_ganados, puntos_antes, puntos_despues, total_venta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [empresaId, clienteId, facturaId, "REDENCION", -puntosSolicitados, saldoActual, saldoFinal, totalVenta]
    );

    await conn.commit();

    if (io) {
      io.to(`empresa_${empresaId}`).emit("puntos_redimidos", {
        cliente_id: clienteId,
        puntos_redimidos: puntosSolicitados,
        descuento,
        saldo_restante: saldoFinal,
      });
    }

    return {
      puntos_redimidos: puntosSolicitados,
      descuento,
      saldo_restante: saldoFinal,
    };
  } catch (err) {
    if (conn) await conn.rollback();
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// ─── DATOS DEL CLIENTE ───────────────────────────────────────────────────────────

async function getClienteData(empresaId: number, clienteId: number): Promise<any> {
  const [cliRows]: any = await pool.promise().query(
    "SELECT id, nombre, puntos_acumulados, telefono, correo FROM clientes WHERE id = ? AND empresa_id = ?",
    [clienteId, empresaId]
  );
  if (cliRows.length === 0) return null;

  const config = await getConfig(empresaId);
  const tieneLotes = await tablaExiste("lotes_puntos");
  const tieneMovimientos = await tablaExiste("movimientos_puntos");

  // Lotes activos (no expirados)
  let lotes: any[] = [];
  if (tieneLotes) {
    const [lotesRows]: any = await pool.promise().query(
      `SELECT * FROM lotes_puntos
       WHERE empresa_id = ? AND cliente_id = ? AND estado = 'ACTIVO'
       ORDER BY fecha_vencimiento ASC`,
      [empresaId, clienteId]
    );
    lotes = lotesRows;

    // Marcar próximos a vencer (30 días)
    lotes = lotes.map((l: any) => ({
      ...l,
      proximo_a_vencer: l.fecha_vencimiento && (new Date(l.fecha_vencimiento).getTime() - Date.now()) < 30 * 24 * 60 * 60 * 1000,
    }));
  }

  // Puntos próximos a vencer
  let puntosProximoVencer = 0;
  if (tieneLotes && lotes.length > 0) {
    const treintaDias = new Date();
    treintaDias.setDate(treintaDias.getDate() + 30);
    puntosProximoVencer = lotes
      .filter((l: any) => l.fecha_vencimiento && new Date(l.fecha_vencimiento) <= treintaDias)
      .reduce((sum: number, l: any) => sum + (parseInt(l.puntos_disponibles) || 0), 0);
  }

  // Puntos vencidos (histórico)
  let puntosVencidos = 0;
  if (tieneLotes) {
    const [vencidos]: any = await pool.promise().query(
      `SELECT COALESCE(SUM(puntos_generados - puntos_disponibles), 0) AS total FROM lotes_puntos
       WHERE empresa_id = ? AND cliente_id = ? AND estado = 'EXPIRADO'`,
      [empresaId, clienteId]
    );
    puntosVencidos = parseInt(vencidos[0]?.total) || 0;
  }

  // Movimientos recientes
  let movimientos: any[] = [];
  if (tieneMovimientos) {
    const [movRows]: any = await pool.promise().query(
      `SELECT * FROM movimientos_puntos
       WHERE empresa_id = ? AND cliente_id = ?
       ORDER BY fecha DESC LIMIT 20`,
      [empresaId, clienteId]
    );
    movimientos = movRows;
  } else {
    // Fallback: usar historial_puntos
    const [histRows]: any = await pool.promise().query(
      `SELECT hp.*, c.nombre AS cliente_nombre
       FROM historial_puntos hp
       LEFT JOIN clientes c ON hp.cliente_id = c.id
       WHERE hp.empresa_id = ? AND hp.cliente_id = ?
       ORDER BY hp.fecha DESC LIMIT 20`,
      [empresaId, clienteId]
    );
    movimientos = histRows;
  }

  // Nivel del cliente
  let nivel: any = null;
  if (config.tieneNiveles && config.niveles.length > 0) {
    const tieneNivelCol = await columnaExiste("clientes", "nivel_cliente_id");
    if (tieneNivelCol) {
      const [cliNivel]: any = await pool.promise().query(
        "SELECT nivel_cliente_id FROM clientes WHERE id = ?",
        [clienteId]
      );
      if (cliNivel.length > 0 && cliNivel[0].nivel_cliente_id) {
        nivel = config.niveles.find((n: any) => n.id === cliNivel[0].nivel_cliente_id) || null;
      }
    }
    if (!nivel && config.niveles.length > 0) {
      nivel = config.niveles[0]; // Default al nivel más bajo
    }
  }

  const cliente = cliRows[0];
  const saldo = parseInt(cliente.puntos_acumulados) || 0;

  return {
    cliente: {
      id: cliente.id,
      nombre: cliente.nombre,
      telefono: cliente.telefono,
      correo: cliente.correo,
    },
    puntos_acumulados: saldo,
    nivel,
    lotes,
    puntos_proximo_vencer: puntosProximoVencer,
    puntos_vencidos: puntosVencidos,
    movimientos_recientes: movimientos,
    config,
  };
}

// ─── MOVIMIENTOS (AUDITORÍA) ─────────────────────────────────────────────────────

async function getMovimientos(
  empresaId: number,
  page: number,
  limit: number,
  clienteId?: number | null,
  tipo?: string | null
): Promise<{ data: any[]; total: number; page: number; last_page: number }> {
  const tieneMovimientos = await tablaExiste("movimientos_puntos");
  const offset = (page - 1) * limit;

  if (tieneMovimientos) {
    let where = "mp.empresa_id = ?";
    const params: any[] = [empresaId];
    if (clienteId) { where += " AND mp.cliente_id = ?"; params.push(clienteId); }
    if (tipo) { where += " AND mp.tipo_movimiento = ?"; params.push(tipo); }

    const [[{ total }]]: any = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM movimientos_puntos mp WHERE ${where}`, params
    );
    const [rows]: any = await pool.promise().query(
      `SELECT mp.*, c.nombre AS cliente_nombre
       FROM movimientos_puntos mp
       LEFT JOIN clientes c ON mp.cliente_id = c.id
       WHERE ${where}
       ORDER BY mp.fecha DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { data: rows, total, page, last_page: Math.ceil(total / limit) };
  }

  // Fallback a historial_puntos
  let where = "hp.empresa_id = ?";
  const params: any[] = [empresaId];
  if (clienteId) { where += " AND hp.cliente_id = ?"; params.push(clienteId); }

  const [[{ total }]]: any = await pool.promise().query(
    `SELECT COUNT(*) AS total FROM historial_puntos hp WHERE ${where}`, params
  );
  const [rows]: any = await pool.promise().query(
    `SELECT hp.*, c.nombre AS cliente_nombre, 'GENERACION' AS tipo_movimiento
     FROM historial_puntos hp
     LEFT JOIN clientes c ON hp.cliente_id = c.id
     WHERE ${where}
     ORDER BY hp.fecha DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { data: rows, total, page, last_page: Math.ceil(total / limit) };
}

// ─── BREAKAGE ────────────────────────────────────────────────────────────────────

async function getBreakage(empresaId: number, fecha?: string): Promise<any> {
  const tieneBreakage = await tablaExiste("breakage_puntos");
  const tieneLotes = await tablaExiste("lotes_puntos");
  const tieneMovimientos = await tablaExiste("movimientos_puntos");

  if (tieneBreakage) {
    if (fecha) {
      const [rows]: any = await pool.promise().query(
        "SELECT * FROM breakage_puntos WHERE empresa_id = ? AND fecha = ?",
        [empresaId, fecha]
      );
      if (rows.length > 0) return rows[0];
    }
    const [rows]: any = await pool.promise().query(
      "SELECT * FROM breakage_puntos WHERE empresa_id = ? ORDER BY fecha DESC LIMIT 30",
      [empresaId]
    );
    return rows;
  }

  // Calcular en vivo desde lotes/movimientos
  if (tieneLotes) {
    const [emitidos]: any = await pool.promise().query(
      "SELECT COALESCE(SUM(puntos_generados), 0) AS total FROM lotes_puntos WHERE empresa_id = ?",
      [empresaId]
    );
    const [redimidos]: any = await pool.promise().query(
      "SELECT COALESCE(SUM(puntos_generados - puntos_disponibles), 0) AS total FROM lotes_puntos WHERE empresa_id = ? AND estado = 'ACTIVO'",
      [empresaId]
    );
    const [expirados]: any = await pool.promise().query(
      "SELECT COALESCE(SUM(puntos_generados), 0) AS total FROM lotes_puntos WHERE empresa_id = ? AND estado = 'EXPIRADO'",
      [empresaId]
    );
    const [activos]: any = await pool.promise().query(
      "SELECT COALESCE(SUM(puntos_disponibles), 0) AS total FROM lotes_puntos WHERE empresa_id = ? AND estado = 'ACTIVO'",
      [empresaId]
    );

    const totalEmitidos = parseInt(emitidos[0]?.total) || 0;
    const totalRedimidos = parseInt(redimidos[0]?.total) || 0;
    const totalExpirados = parseInt(expirados[0]?.total) || 0;
    const totalActivos = parseInt(activos[0]?.total) || 0;

    return {
      puntos_emitidos: totalEmitidos,
      puntos_redimidos: totalRedimidos,
      puntos_expirados: totalExpirados,
      puntos_activos: totalActivos,
      porcentaje_redencion: totalEmitidos > 0 ? Math.round((totalRedimidos / totalEmitidos) * 10000) / 100 : 0,
      porcentaje_breakage: totalEmitidos > 0 ? Math.round((totalExpirados / totalEmitidos) * 10000) / 100 : 0,
    };
  }

  // Fallback mínimo
  const [clientes]: any = await pool.promise().query(
    "SELECT COALESCE(SUM(puntos_acumulados), 0) AS total FROM clientes WHERE empresa_id = ?",
    [empresaId]
  );
  return {
    puntos_activos: parseInt(clientes[0]?.total) || 0,
    puntos_emitidos: 0,
    puntos_redimidos: 0,
    puntos_expirados: 0,
    porcentaje_redencion: 0,
    porcentaje_breakage: 0,
  };
}

// ─── EJECUTAR EXPIRACIÓN ─────────────────────────────────────────────────────────

async function ejecutarExpiracion(empresaId: number): Promise<{ lotes_expirados: number; puntos_expirados: number }> {
  const tieneLotes = await tablaExiste("lotes_puntos");
  if (!tieneLotes) return { lotes_expirados: 0, puntos_expirados: 0 };

  const tieneMovimientos = await tablaExiste("movimientos_puntos");

  const [lotesVencer]: any = await pool.promise().query(
    `SELECT id, cliente_id, puntos_disponibles FROM lotes_puntos
     WHERE empresa_id = ? AND estado = 'ACTIVO' AND fecha_vencimiento < CURDATE()`,
    [empresaId]
  );

  if (lotesVencer.length === 0) return { lotes_expirados: 0, puntos_expirados: 0 };

  let totalPuntos = 0;
  for (const lote of lotesVencer) {
    const puntos = parseInt(lote.puntos_disponibles) || 0;
    totalPuntos += puntos;

    // Cambiar estado
    await pool.promise().query(
      "UPDATE lotes_puntos SET estado = 'EXPIRADO', puntos_disponibles = 0 WHERE id = ?",
      [lote.id]
    );

    // Registrar movimiento
    if (tieneMovimientos && puntos > 0) {
      const [cliRow]: any = await pool.promise().query(
        "SELECT puntos_acumulados FROM clientes WHERE id = ?",
        [lote.cliente_id]
      );
      const saldoActual = parseInt(cliRow[0]?.puntos_acumulados) || 0;
      const nuevoSaldo = Math.max(0, saldoActual - puntos);

      await pool.promise().query(
        `INSERT INTO movimientos_puntos
          (empresa_id, cliente_id, lote_id, tipo_movimiento, puntos, saldo_anterior, saldo_posterior, descripcion)
         VALUES (?, ?, ?, 'EXPIRACION', ?, ?, ?, ?)`,
        [empresaId, lote.cliente_id, lote.id, -puntos, saldoActual, nuevoSaldo,
         `Vencimiento de lote #${lote.id}: ${puntos} pts`]
      );

      // Descontar del saldo del cliente
      await pool.promise().query(
        "UPDATE clientes SET puntos_acumulados = GREATEST(0, puntos_acumulados - ?) WHERE id = ?",
        [puntos, lote.cliente_id]
      );
    }
  }

  return { lotes_expirados: lotesVencer.length, puntos_expirados: totalPuntos };
}

// ─── AJUSTE MANUAL ───────────────────────────────────────────────────────────────

async function ajusteManual(
  empresaId: number,
  clienteId: number,
  puntos: number,
  motivo: string,
  cajeroId: number | null
): Promise<{ nuevo_saldo: number }> {
  if (puntos === 0) throw new Error("Los puntos a ajustar no pueden ser 0.");

  const tieneMovimientos = await tablaExiste("movimientos_puntos");
  const promisePool = pool.promise();
  let conn;
  try {
    conn = await promisePool.getConnection();
    await conn.beginTransaction();

    const [cliRow]: any = await conn.query(
      "SELECT puntos_acumulados FROM clientes WHERE id = ? AND empresa_id = ? FOR UPDATE",
      [clienteId, empresaId]
    );
    if (cliRow.length === 0) throw new Error("Cliente no encontrado");

    const saldoActual = parseInt(cliRow[0].puntos_acumulados) || 0;
    if (puntos < 0 && saldoActual + puntos < 0) {
      throw new Error(`El cliente solo tiene ${saldoActual} puntos. No puedes descontar ${Math.abs(puntos)}.`);
    }

    const nuevoSaldo = saldoActual + puntos;

    if (tieneMovimientos) {
      await conn.query(
        `INSERT INTO movimientos_puntos
          (empresa_id, cliente_id, tipo_movimiento, puntos, saldo_anterior, saldo_posterior, descripcion, cajero_id)
         VALUES (?, ?, 'AJUSTE', ?, ?, ?, ?, ?)`,
        [empresaId, clienteId, puntos, saldoActual, nuevoSaldo, motivo, cajeroId]
      );
    }

    await conn.query(
      "UPDATE clientes SET puntos_acumulados = ? WHERE id = ?",
      [nuevoSaldo, clienteId]
    );

    await conn.commit();
    return { nuevo_saldo: nuevoSaldo };
  } catch (err) {
    if (conn) await conn.rollback();
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────────

export default {
  getConfig,
  saveConfig,
  getNiveles,
  saveNivel,
  deleteNivel,
  getCampanias,
  saveCampania,
  deleteCampania,
  acumular,
  redimir,
  getClienteData,
  getMovimientos,
  getBreakage,
  ejecutarExpiracion,
  ajusteManual,
};
