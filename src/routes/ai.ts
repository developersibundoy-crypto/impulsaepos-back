import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Ruta para generar predicciones y análisis estadísticos inteligentes (Auditada para Multi-Tenant)
router.get("/predicciones", verifyTokenAndTenant, async (req: any, res: any) => {
  try {
    const empresa_id = req.user.empresa_id;
    const promiseDb = connection.promise();

    // 1. Obtener ventas históricas FILTRADAS por Tenant ID
    const query = `
      SELECT 
        v.producto_id,
        p.nombre,
        p.categoria,
        p.cantidad AS stock_actual,
        p.precio_venta,
        DATE_FORMAT(f.fecha, '%Y-%m') AS mes,
        SUM(v.cantidad) AS total_vendido,
        SUM(v.cantidad * v.precio_unitario) AS ingresos_mes
      FROM ventas v
      JOIN facturas_venta f ON v.factura_id = f.id
      JOIN productos p ON v.producto_id = p.id
      WHERE f.empresa_id = ?
      GROUP BY v.producto_id, p.nombre, p.categoria, p.cantidad, p.precio_venta, mes
      ORDER BY mes ASC
    `;
    const [rows]: any = await promiseDb.query(query, [empresa_id]);

    // 2. Procesar y normalizar los datos por producto
    const authData: Record<string, {
      id: number;
      nombre: string;
      categoria: string;
      stock_actual: number;
      precio_unitario: number;
      historia: { mes: string; cantidad: number; ingresos: number }[];
      total_vendido: number;
      total_ingresos: number;
    }> = {};

    rows.forEach(row => {
      const { producto_id, nombre, categoria, stock_actual, precio_venta, mes, total_vendido, ingresos_mes } = row;
      if (!authData[producto_id]) {
        authData[producto_id] = { 
          id: producto_id, 
          nombre, 
          categoria, 
          stock_actual, 
          precio_unitario: Number(precio_venta),
          historia: [], 
          total_vendido: 0,
          total_ingresos: 0
        };
      }
      authData[producto_id].historia.push({ mes, cantidad: Number(total_vendido), ingresos: Number(ingresos_mes) });
      authData[producto_id].total_vendido += Number(total_vendido);
      authData[producto_id].total_ingresos += Number(ingresos_mes);
    });

    // 3. Obtener los últimos proveedores desde el Kardex para cada producto (Optimizado con JOIN)
    const [auditProviders]: any = await promiseDb.query(
      `SELECT k1.producto_id, k1.motivo 
       FROM kardex k1
       INNER JOIN (
         SELECT MAX(id) as max_id 
         FROM kardex 
         WHERE empresa_id = ? AND tipo_movimiento IN ('ENTRADA', 'COMPRA_SERVICIO')
         GROUP BY producto_id
       ) k2 ON k1.id = k2.max_id`, [empresa_id]
    );

    const providerMap: Record<number, string> = {};
    auditProviders.forEach((ap: any) => {
        const prov = (ap.motivo || "").replace("Compra Factura: ", "");
        providerMap[ap.producto_id] = prov || "Proveedor Genérico";
    });

    // 4. Motor de Inteligencia Empresarial - Análisis Estratégico
    const recomendaciones = [];
    const graficaMensual: Record<string, { mes: string; real: number; proyectado?: number }> = {};
    const totalVentasGlobal = Object.values(authData).reduce((acc, p) => acc + p.total_vendido, 0);

    // Clasificación ABC (Pareto) - Ordenar por volumen de ventas
    const sortedProducts = Object.values(authData).sort((a, b) => b.total_vendido - a.total_vendido);

    sortedProducts.forEach((prod, index) => {
      // Sumar al gráfico macro
      prod.historia.forEach(h => {
        if (!graficaMensual[h.mes]) graficaMensual[h.mes] = { mes: h.mes, real: 0 };
        graficaMensual[h.mes].real += h.cantidad;
      });

      // Algoritmo de Tendencia Predictiva (Weighted Moving Average + Linear Drift)
      let prediccion_unidades = 0;
      if (prod.historia.length >= 2) {
        const ult = prod.historia[prod.historia.length - 1].cantidad;
        const penult = prod.historia[prod.historia.length - 2].cantidad;
        const tendencia = ult - penult;
        const avg = prod.total_vendido / prod.historia.length;
        
        // Ponderación dinámica: 50% último mes, 30% promedio, 20% inercia de crecimiento
        prediccion_unidades = Math.round((ult * 0.5) + (avg * 0.3) + (tendencia * 0.2) + (ult * 0.05));
      } else if (prod.historia.length === 1) {
        prediccion_unidades = Math.round(prod.historia[0].cantidad * 1.10); // Crecimiento debut 10%
      }
      if (prediccion_unidades < 0) prediccion_unidades = 0;

      // Análisis de Categoría ABC
      const percentile = (index + 1) / sortedProducts.length;
      let clase = "C (Baja Rotación)";
      if (percentile <= 0.2) clase = "A (Producto Estrella)";
      else if (percentile <= 0.5) clase = "B (Moderado)";

      // Cálculo de Brecha y Estado
      let sugerencia = prediccion_unidades - prod.stock_actual;
      let status = "✅ BALANCEADO";
      let impacto_economico = prediccion_unidades * prod.precio_unitario;

      if (sugerencia > 0) {
        status = "⚠️ REABASTECER";
      } else {
        sugerencia = 0;
        if (prod.stock_actual > prediccion_unidades * 3 && prod.total_vendido > 0) {
          status = "🧊 EXCESO DE STOCK";
        } else if (prod.total_vendido === 0) {
          status = "💀 PRODUCTO MUERTO";
        }
      }

      recomendaciones.push({
        id: prod.id,
        nombre: prod.nombre,
        categoria: prod.categoria,
        clase_abc: clase,
        stock_disponible: prod.stock_actual,
        vendido_total: prod.total_vendido,
        proyeccion_demanda: prediccion_unidades,
        faltante: sugerencia,
        oportunidad_venta_usd: impacto_economico,
        proveedor_sugerido: providerMap[prod.id] || "No registra compras previas",
        status: status
      });
    });

    // 5. Proyección Visual para el Frontend
    let dataGrafica = Object.values(graficaMensual).sort((a, b) => a.mes.localeCompare(b.mes));
    const totalProyectado = recomendaciones.reduce((acc, curr) => acc + curr.proyeccion_demanda, 0);

    if (dataGrafica.length > 0) {
      dataGrafica[dataGrafica.length - 1].proyectado = dataGrafica[dataGrafica.length - 1].real;
      const lastMonth = dataGrafica[dataGrafica.length - 1].mes;
      const [year, month] = lastMonth.split('-').map(Number);
      const d = new Date(year, month, 1); // El mes en JS es 0-indexed, así que month (que es el siguiente número real) ya es el siguiente mes.
      
      const nextMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')} (Predicción)`;

      dataGrafica.push({
        mes: nextMonth,
        real: 0,
        proyectado: totalProyectado
      });
    }

    res.json({
      resumenEjecutivo: {
        totalEmpresa: empresa_id,
        productosAnalizados: recomendaciones.length,
        potencialIngresosProximoMes: recomendaciones.reduce((acc, c) => acc + c.oportunidad_venta_usd, 0)
      },
      tendenciaGeneral: dataGrafica,
      analisisInteligente: recomendaciones.sort((a, b) => {
          if (a.clase_abc[0] !== b.clase_abc[0]) return a.clase_abc.localeCompare(b.clase_abc);
          return b.proyeccion_demanda - a.proyeccion_demanda;
      })
    });

  } catch (err) {
    console.error("Critical Failure in AI Engine:", err);
    res.status(500).json({ error: "Error procesando modelos de inteligencia multi-tenant." });
  }
});

// Endpoint en AI para alertas de vencimiento con umbral de días dinámico y configurable
router.get("/proximos-vencer", verifyTokenAndTenant, async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const promiseDb = connection.promise();

  try {
    let diasLimite = 30;

    if (req.query.dias) {
      const parsed = parseInt(req.query.dias as string, 10);
      if (!isNaN(parsed) && parsed > 0) {
        diasLimite = parsed;
      }
    } else {
      try {
        const [configRows]: any = await promiseDb.query(
          "SELECT dias_alerta_vencimiento FROM empresa_config WHERE empresa_id = ?",
          [empresa_id]
        );
        if (configRows && configRows.length > 0 && configRows[0].dias_alerta_vencimiento) {
          diasLimite = Number(configRows[0].dias_alerta_vencimiento);
        }
      } catch (cfgErr) {
        // En caso de que la columna aún no exista o tabla vacía
      }
    }

    const query = `
      SELECT id, nombre, referencia, categoria, cantidad, fecha_vencimiento,
             DATEDIFF(fecha_vencimiento, CURDATE()) as dias_faltantes
      FROM productos
      WHERE empresa_id = ? 
        AND fecha_vencimiento IS NOT NULL 
        AND fecha_vencimiento >= CURDATE()
        AND fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
      ORDER BY fecha_vencimiento ASC
    `;

    const [results]: any = await promiseDb.query(query, [empresa_id, diasLimite]);
    res.json(results);
  } catch (err) {
    console.error("Error fetching near expiry products in AI:", err);
    res.status(500).json({ error: "Error al obtener productos por vencer" });
  }
});

// Obtener la configuración de días de alerta de la empresa
router.get("/config-vencimiento", verifyTokenAndTenant, async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const promiseDb = connection.promise();
  try {
    const [rows]: any = await promiseDb.query(
      "SELECT dias_alerta_vencimiento FROM empresa_config WHERE empresa_id = ?",
      [empresa_id]
    );
    const dias = (rows && rows.length > 0 && rows[0].dias_alerta_vencimiento) ? Number(rows[0].dias_alerta_vencimiento) : 30;
    res.json({ dias_alerta_vencimiento: dias });
  } catch (err) {
    res.json({ dias_alerta_vencimiento: 30 });
  }
});

// Guardar los días de alerta fijados manualmente por el administrador
router.post("/config-vencimiento", verifyTokenAndTenant, async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const promiseDb = connection.promise();
  const dias = parseInt(req.body.dias, 10);
  if (isNaN(dias) || dias <= 0) {
    return res.status(400).json({ error: "El número de días debe ser mayor a 0" });
  }

  try {
    try {
      await promiseDb.query("ALTER TABLE empresa_config ADD COLUMN dias_alerta_vencimiento INT DEFAULT 30");
    } catch (colErr: any) {
      // Ignorar si ya existe
    }

    await promiseDb.query(
      "UPDATE empresa_config SET dias_alerta_vencimiento = ? WHERE empresa_id = ?",
      [dias, empresa_id]
    );
    res.json({ success: true, dias_alerta_vencimiento: dias, message: "Días de alerta guardados correctamente" });
  } catch (err: any) {
    console.error("Error guardando dias_alerta_vencimiento:", err);
    res.status(500).json({ error: "Error al guardar configuración de vencimiento" });
  }
});

export default router;
