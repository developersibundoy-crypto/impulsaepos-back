// DECIMAL(15,2): no redondear entradas ni aceptar fracciones de centavo.
export function centavos(valor: any) {
  if (!/^-?\d+(\.\d{1,2})?$/.test(String(valor))) throw new Error('Importe inválido: máximo dos decimales');
  const n = Number(valor);
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > 999999999999999) throw new Error('Importe fuera de rango');
  return cents;
}

export function normalizarHistorico(a: any) {
  const monto = Number(a.monto), ef = Number(a.pago_efectivo || 0), tr = Number(a.pago_transferencia || 0);
  const coherente = Math.round((ef + tr) * 100) === Math.round(monto * 100) &&
    [ef, tr].every(n => monto >= 0 ? n >= 0 : n <= 0);
  // El método de una devolución con medios cero no demuestra el egreso físico.
  const inferible = monto > 0 && ef === 0 && tr === 0 &&
    ['Efectivo', 'Transferencia', 'Tarjeta', 'Addi', 'Sistecredito'].includes(a.metodo_pago);
  const metodo = String(a.metodo_pago).replace(/^Devolución /, '');
  const contradiccion = coherente && (metodo === 'Efectivo' ? tr !== 0 :
    ['Transferencia', 'Tarjeta', 'Addi', 'Sistecredito'].includes(metodo) ? ef !== 0 : false);
  return { ...a, pago_efectivo_crudo: a.pago_efectivo === null ? null : ef, pago_transferencia_crudo: a.pago_transferencia === null ? null : tr,
    pago_efectivo: coherente ? ef : inferible ? (a.metodo_pago === 'Efectivo' ? monto : 0) : null,
    pago_transferencia: coherente ? tr : inferible ? (a.metodo_pago === 'Efectivo' ? 0 : monto) : null,
    medio_inferido: inferible, inconsistencia_historica: (!coherente && !inferible) || contradiccion,
    estado_medio: coherente ? (contradiccion ? 'Registrado: método declarado inconsistente' : 'Registrado') : inferible ? 'Inferido por método de ingreso' : 'Pendiente de conciliación: medio físico desconocido' };
}

export function resumenFlujo(abonos: any[]) {
  const sum = (pick: (a: any) => number) => abonos.reduce((acc, a) => acc + Math.round(pick(a) * 100), 0) / 100;
  return { recibido_nominal: sum(a => Math.max(0, Number(a.monto))), devuelto_nominal: sum(a => Math.max(0, -Number(a.monto))),
    neto_nominal: sum(a => Number(a.monto)), efectivo_recibido: sum(a => Math.max(0, Number(a.pago_efectivo || 0))),
    efectivo_devuelto: sum(a => Math.max(0, -Number(a.pago_efectivo || 0))),
    efectivo_inferido: sum(a => a.medio_inferido ? Number(a.pago_efectivo || 0) : 0),
    movimientos_medio_desconocido: abonos.filter(a => a.pago_efectivo === null).length };
}

// Los pagos simples se derivan del monto neto, no de los ceros enviados por la UI.
export function distribuirAbono(monto: any, body: any) {
  const valor = centavos(monto) / 100;
  if (!Number.isFinite(valor) || valor <= 0) throw new Error('Monto de abono inválido');
  const metodo = body.metodo_pago || 'Efectivo';
  if (metodo === 'Efectivo') return { metodo, efectivo: valor, transferencia: 0 };
  if (['Transferencia', 'Tarjeta', 'Addi', 'Sistecredito'].includes(metodo)) {
    return { metodo, efectivo: 0, transferencia: valor };
  }
  if (metodo !== 'Mixto') throw new Error('Método de pago inválido');
  const efectivo = centavos(body.pago_efectivo || 0) / 100;
  const transferencia = centavos(body.pago_transferencia || 0) / 100;
  if (![efectivo, transferencia].every(n => Number.isFinite(n) && n >= 0) ||
      centavos(body.pago_efectivo || 0) + centavos(body.pago_transferencia || 0) !== centavos(monto)) {
    throw new Error('Los medios de pago deben sumar el monto del abono');
  }
  return { metodo, efectivo, transferencia };
}

export function distribuirDevolucion(total: number, efectivo: number, transferencia: number, body: any) {
  const explicito = body.devolucion_efectivo !== undefined || body.devolucion_transferencia !== undefined;
  if (!explicito) throw new Error('Indique monto y medio real de devolución');
  const ec = centavos(body.devolucion_efectivo || 0), tc = centavos(body.devolucion_transferencia || 0);
  const ef = ec / 100, tr = tc / 100, monto = (ec + tc) / 100;
  if (ec < 0 || tc < 0 || ec + tc <= 0 || ec + tc > centavos(total)) {
    throw new Error('Devolución inválida o superior al dinero pendiente por devolver');
  }
  return { monto, efectivo: ef, transferencia: tr,
    metodo: ef > 0 && tr > 0 ? 'Devolución Mixto' : ef > 0 ? 'Devolución Efectivo' : 'Devolución Transferencia' };
}

// Asociación de turno sin DDL: movimiento de auditoría de monto cero.
// El dinero se contabiliza exclusivamente desde abonos_separados.
export async function obtenerTurnoAbono(conn: any, req: any) {
  const [sesiones]: any = await conn.query(
    "SELECT id FROM sesiones_caja WHERE usuario_id = ? AND empresa_id = ? AND estado = 'Abierta' ORDER BY fecha_apertura DESC LIMIT 1 FOR UPDATE",
    [req.user.id, req.user.empresa_id]
  );
  if (!sesiones.length) throw new Error('Abre una sesión de caja para registrar el pago o la devolución');
  const cajero = req.user.cajero_id || req.body?.cajero_id || null;
  if (cajero) {
    const [rows]: any = await conn.query('SELECT id FROM cajeros WHERE id = ? AND empresa_id = ?', [cajero, req.user.empresa_id]);
    if (!rows.length) throw new Error('Cajero no pertenece a la empresa');
  }
  return { id: sesiones[0].id, cajero };
}

export async function registrarAbono(conn: any, req: any, separadoId: any, monto: number, pago: any) {
  const turno = await obtenerTurnoAbono(conn, req);
  const [result]: any = await conn.query(
    'INSERT INTO abonos_separados (empresa_id, separado_id, cajero_id, monto, metodo_pago, pago_efectivo, pago_transferencia) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.user.empresa_id, separadoId, turno.cajero, monto, pago.metodo, pago.efectivo, pago.transferencia]
  );
  await conn.query(
    "INSERT INTO movimientos_caja (empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion) VALUES (?, ?, ?, 'Ingreso', 0, ?)",
    [req.user.empresa_id, req.user.id, turno.id, `ABONO_SEPARADO:${result.insertId}`]
  );
  return { abono_id: result.insertId, turno_id: turno.id };
}

// Solo una referencia canónica válida puede vincular un abono. Los históricos requieren
// un único turno compatible con cajero y fecha (incluido límite de cierre).
function referencias() {
  return `SELECT m.sesion_caja_id FROM movimientos_caja m JOIN sesiones_caja sc
    ON sc.id = m.sesion_caja_id AND sc.empresa_id = m.empresa_id AND sc.usuario_id = m.usuario_id
    WHERE m.empresa_id = a.empresa_id AND BINARY m.descripcion = BINARY CONCAT('ABONO_SEPARADO:', a.id)
    AND m.tipo = 'Ingreso' AND m.monto = 0`;
}
function candidatos() {
  return `SELECT sc.id FROM sesiones_caja sc JOIN usuarios_plataforma u ON u.id = sc.usuario_id
    AND u.empresa_id = sc.empresa_id WHERE sc.empresa_id = a.empresa_id
    AND a.cajero_id IS NOT NULL AND u.cajero_id = a.cajero_id
    AND DATE(sc.fecha_apertura) = DATE(a.fecha_pago)
    AND a.fecha_pago >= sc.fecha_apertura AND a.fecha_pago <= COALESCE(sc.fecha_cierre, CURRENT_TIMESTAMP)`;
}
export function filtroTurnoSeparado() {
  return `AND (CASE WHEN (${referencias().replace('SELECT m.sesion_caja_id', 'SELECT COUNT(*)')}) = 1
    THEN (${referencias()}) WHEN NOT EXISTS (${referencias()})
    AND (${candidatos().replace('SELECT sc.id', 'SELECT COUNT(*)')}) = 1 THEN (${candidatos()}) ELSE NULL END) = ?`;
}

export async function rastreoSeparados(conn: any, empresa: any) {
  const [rows]: any = await conn.query(`SELECT a.*,
    (${referencias().replace('SELECT m.sesion_caja_id', 'SELECT COUNT(*)')}) AS referencias_validas,
    (${referencias().replace('SELECT m.sesion_caja_id', 'SELECT MIN(m.sesion_caja_id)')}) AS turno_referencia,
    (${candidatos().replace('SELECT sc.id', 'SELECT COUNT(*)')}) AS turnos_candidatos,
    (${candidatos().replace('SELECT sc.id', 'SELECT MIN(sc.id)')}) AS turno_candidato
    FROM abonos_separados a WHERE a.empresa_id = ?`, [empresa]);
  return rows.map((a: any) => ({ ...normalizarHistorico(a),
    turno_id: Number(a.referencias_validas) === 1 ? a.turno_referencia : Number(a.referencias_validas) === 0 && Number(a.turnos_candidatos) === 1 ? a.turno_candidato : null,
    atribucion: Number(a.referencias_validas) === 1 ? 'Referencia de turno' : Number(a.referencias_validas) === 0 && Number(a.turnos_candidatos) === 1 ? 'Inferida: único turno compatible' : 'Pendiente de atribución' }));
}

export async function advertenciasCaja(conn: any, empresa: any) {
  const rows = await rastreoSeparados(conn, empresa);
  const pendientes = rows.filter((a: any) => !a.turno_id || a.inconsistencia_historica);
  return { conciliacion_pendiente: pendientes.length > 0, separados_pendientes_conciliacion: pendientes,
    criterio_conciliacion: 'Los históricos sin referencia requieren único turno del mismo día con cajero compatible; NULL, turnos de días anteriores y medios incoherentes quedan pendientes.' };
}

export function consultaCajaSeparados(empresa: any, cajero: any, sesion: any) {
  const filtroCajero = cajero ? 'AND (cajero_id = ? OR cajero_id IS NULL)' : '';
  const sql = `SELECT SUM(total_bruto) AS total_ventas, SUM(efectivo) AS total_efectivo,
    SUM(IF(metodo_pago LIKE '%Transferencia%' OR metodo_pago LIKE '%Mixto%', transferencia, 0)) AS total_transferencia,
    SUM(IF(metodo_pago = 'Tarjeta', transferencia, 0)) AS total_tarjeta,
    SUM(IF(metodo_pago = 'Addi', transferencia, 0)) AS total_addi,
    SUM(IF(metodo_pago = 'Sistecredito', transferencia, 0)) AS total_sistecredito,
    SUM(IF(tipo_origen = 'ABONO_SEPARADO', total_bruto, 0)) AS total_abonos_separados,
    SUM(IF(tipo_origen = 'DEVOLUCION_SEPARADO', ABS(total_bruto), 0)) AS total_devoluciones_separados,
    SUM(IF(tipo_origen = 'ABONO_SEPARADO', efectivo, 0)) AS efectivo_abonos_separados,
    SUM(IF(tipo_origen = 'DEVOLUCION_SEPARADO', ABS(efectivo), 0)) AS efectivo_devoluciones_separados
    FROM (
      SELECT total AS total_bruto, pago_efectivo AS efectivo, pago_transferencia AS transferencia,
        metodo_pago, 'VENTA' AS tipo_origen FROM facturas_venta fv
      WHERE empresa_id = ? ${filtroCajero} AND fecha >= ? AND fecha <= CURRENT_TIMESTAMP
        AND metodo_pago <> 'Separado'
        AND NOT EXISTS (SELECT 1 FROM kardex k WHERE k.empresa_id = fv.empresa_id
          AND k.referencia = CONCAT('FS-', fv.id) AND k.motivo = 'Conversión Separado a Venta')
      UNION ALL
      SELECT total, pago_efectivo, pago_transferencia, metodo_pago, 'VENTA_ELEC' FROM facturas_electronicas
      WHERE empresa_id = ? ${filtroCajero} AND fecha_emision >= ? AND fecha_emision <= CURRENT_TIMESTAMP
      UNION ALL
      SELECT a.monto,
        CASE WHEN COALESCE(a.pago_efectivo,0) + COALESCE(a.pago_transferencia,0) = a.monto AND COALESCE(a.pago_efectivo,0) * a.monto >= 0 AND COALESCE(a.pago_transferencia,0) * a.monto >= 0 THEN COALESCE(a.pago_efectivo,0)
          WHEN a.monto > 0 AND COALESCE(a.pago_efectivo,0) = 0 AND COALESCE(a.pago_transferencia,0) = 0 AND a.metodo_pago = 'Efectivo' THEN a.monto ELSE 0 END,
        CASE WHEN COALESCE(a.pago_efectivo,0) + COALESCE(a.pago_transferencia,0) = a.monto AND COALESCE(a.pago_efectivo,0) * a.monto >= 0 AND COALESCE(a.pago_transferencia,0) * a.monto >= 0 THEN COALESCE(a.pago_transferencia,0)
          WHEN a.monto > 0 AND COALESCE(a.pago_efectivo,0) = 0 AND COALESCE(a.pago_transferencia,0) = 0 AND a.metodo_pago IN ('Transferencia', 'Tarjeta', 'Addi', 'Sistecredito') THEN a.monto ELSE 0 END,
        a.metodo_pago, IF(a.monto > 0, 'ABONO_SEPARADO', 'DEVOLUCION_SEPARADO')
      FROM abonos_separados a
      WHERE a.empresa_id = ? ${filtroTurnoSeparado()}
      UNION ALL
      SELECT saldo_adicional, IF(metodo_pago = 'Efectivo', saldo_adicional, 0),
        IF(metodo_pago != 'Efectivo', saldo_adicional, 0), metodo_pago, 'CAMBIO' FROM cambios_factura
       WHERE empresa_id = ? ${filtroCajero} AND fecha >= ? AND fecha <= CURRENT_TIMESTAMP
         AND (saldo_adicional > 0 OR (saldo_adicional < 0 AND EXISTS
           (SELECT 1 FROM facturas_venta fv WHERE fv.id = cambios_factura.factura_original_id AND fv.empresa_id = cambios_factura.empresa_id
             AND (fv.metodo_pago = 'Separado' OR EXISTS (SELECT 1 FROM kardex k WHERE k.empresa_id = fv.empresa_id
               AND k.referencia = CONCAT('FS-', fv.id) AND k.motivo = 'Conversión Separado a Venta')))))
    ) todas_ventas`;
  const filtro = cajero ? [empresa, cajero, sesion.fecha_apertura] : [empresa, sesion.fecha_apertura];
  return { sql, params: [...filtro, ...filtro, empresa, sesion.id, ...filtro] };
}
