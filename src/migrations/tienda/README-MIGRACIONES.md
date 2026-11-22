# Guía de Migraciones — Impulsa Tienda Online

Este directorio contiene las migraciones oficiales, versionadas y comprobadas para el sistema de pagos SaaS y la Tienda Online de Impulsa POS.

---

## 1. Principios de Diseño
1. **Idempotencia Absoluta**: Cada script puede ejecutarse una o múltiples veces sin duplicar objetos ni corromper datos.
2. **Aditivas (Cero Destrucción)**: No ejecutan `DROP TABLE`, `DROP COLUMN` ni alteran destructivamente estructuras existentes.
3. **Aislamiento Multi-Tenant**: Todas las entidades de negocio cuentan con `empresa_id` indexado y claves foráneas en cascada.
4. **Verificación Automática**: Cada migración incluye su función `verify(conn)` que comprueba tablas, índices y restricciones en `information_schema`.
5. **Seguridad en Despliegue**: El ejecutor `run.cjs` bloquea por defecto cualquier conexión a servidores remotos a menos que se use `--confirm-database=<nombre>` y `--backup-verified`.

---

## 2. Catálogo de Tablas del Sistema

### 🟢 Creadas y Verificadas (Etapa 1B y Etapa 2)

| Tabla | Propósito | Llaves e Índices Críticos |
| :--- | :--- | :--- |
| `schema_migrations` | Control de versiones aplicadas y checksums SHA-256 | `PRIMARY KEY (version)` |
| `pagos_saas_eventos` | Registro y deduplicación de eventos de pasarela (Wompi) para pagos de suscripción SaaS | `UNIQUE (proveedor, evento_id)`, `INDEX (empresa_id, creado_en)` |
| `saas_gastos` | Salidas y gastos operativos de la plataforma SaaS (migrada desde DDL en runtime) | `PRIMARY KEY (id)`, `INDEX (fecha)` |
| `tiendas` | Perfil y configuración de la tienda online (1 tienda por empresa) | `UNIQUE (empresa_id)`, `UNIQUE (slug)`, `UNIQUE (id, empresa_id)`, `FK (empresa_id)` |
| `tienda_slugs_reservados` | Enlaces protegidos que ningún comercio puede tomar (`admin`, `api`, `checkout`, etc.) | `PRIMARY KEY (slug)` |
| `tienda_contrataciones` | Historial y vigencia del derecho de uso del complemento Tienda Online | `UNIQUE (origen, referencia)`, `INDEX (empresa_id, vence_en)`, `FK (empresa_id)` |
| `tienda_publicaciones` | Catálogo de productos seleccionados y publicados para la tienda online | `UNIQUE (tienda_id, producto_id)`, `FK (tienda_id, empresa_id)`, `FK (producto_id)` |
| `tienda_auditoria` | Bitácora durable de transiciones de estado y acciones operativas | `INDEX (empresa_id, entidad, entidad_id, creado_en)` |

### 🟡 Diseñadas para Etapas Posteriores (Se migrarán en su etapa correspondiente)
- `tienda_imagenes` (Etapa 3): Almacenamiento y metadatos de imágenes de productos.
- `tienda_pedidos` (Etapa 5): Pedidos de clientes con token de consulta opaco y clave de idempotencia.
- `tienda_pedido_items` (Etapa 5): Snapshot histórico inmutable de precios, impuestos y nombres al momento de compra.
- `tienda_reservas` (Etapa 5): Retención atómica de stock con TTL y proceso de liberación.
- `tienda_pagos` (Etapa 5 / 6): Registro de transacciones de compra y auditoría de comprobantes.

> **Nota sobre tablas piloto**: Las tablas con prefijo `piloto_*` (`piloto_catalogo_a`, `piloto_pedidos_a`, `piloto_seleccion_a`) son exclusivas del entorno local de desarrollo y **NO** deben desplegarse a producción.

---

## 3. Instrucciones de Ejecución

### En Desarrollo Local
```bash
# Simular ejecución sin aplicar cambios
node src/migrations/tienda/run.cjs --dry-run

# Aplicar migraciones pendientes
node src/migrations/tienda/run.cjs

# Verificar integridad de migraciones ya aplicadas
node src/migrations/tienda/run.cjs --verify-only
```

### En Servidor de Producción (Despliegue Futuro)
1. Realizar respaldo completo de la base de datos de producción con `mysqldump` o la herramienta de hosting.
2. Comprobar que el respaldo es íntegro y restaurable.
3. Establecer las variables de entorno `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
4. Ejecutar con las confirmaciones de seguridad:
```bash
node src/migrations/tienda/run.cjs --confirm-database=u311745467_impulsaepos --backup-verified
```
5. Comprobar la salida:
```text
[migraciones] OK 20261120_001_pagos_saas_eventos
[migraciones] OK 20261120_002_tienda_base
[migraciones] Verificación completa. Pendientes: 0
```
