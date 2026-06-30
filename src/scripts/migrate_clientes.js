const mysql = require('mysql2/promise');

async function migrate() {
  const conn = await mysql.createConnection({host: 'localhost', user: 'root', database: 'tienda_db'});
  
  const columns = [
    { name: 'tipo_persona', def: "VARCHAR(20) DEFAULT 'Natural'" },
    { name: 'primer_nombre', def: 'VARCHAR(100)' },
    { name: 'segundo_nombre', def: 'VARCHAR(100)' },
    { name: 'primer_apellido', def: 'VARCHAR(100)' },
    { name: 'segundo_apellido', def: 'VARCHAR(100)' },
    { name: 'razon_social', def: 'VARCHAR(255)' },
    { name: 'nombre_comercial', def: 'VARCHAR(255)' },
    { name: 'regimen_tributario', def: 'VARCHAR(100)' },
    { name: 'responsabilidad_fiscal', def: 'VARCHAR(100)' },
    { name: 'codigo_tributario_dian', def: 'VARCHAR(50)' },
    { name: 'obligado_facturar', def: 'BOOLEAN DEFAULT 0' },
    { name: 'gran_contribuyente', def: 'BOOLEAN DEFAULT 0' },
    { name: 'autorretenedor', def: 'BOOLEAN DEFAULT 0' },
    { name: 'correo_alternativo', def: 'VARCHAR(100)' },
    { name: 'telefono_fijo', def: 'VARCHAR(50)' },
    { name: 'pais', def: "VARCHAR(100) DEFAULT 'Colombia'" },
    { name: 'departamento', def: 'VARCHAR(100)' },
    { name: 'ciudad', def: 'VARCHAR(100)' },
    { name: 'codigo_postal', def: 'VARCHAR(20)' },
    { name: 'estado', def: "VARCHAR(20) DEFAULT 'Activo'" },
    { name: 'observaciones', def: 'TEXT' },
    { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
    { name: 'updated_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' }
  ];

  for (const col of columns) {
    try {
      await conn.query(`ALTER TABLE clientes ADD COLUMN ${col.name} ${col.def}`);
      console.log(`Added column ${col.name}`);
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log(`Column ${col.name} already exists. Skipping.`);
      } else {
        console.error(`Error adding ${col.name}:`, e.message);
      }
    }
  }
  
  await conn.end();
  console.log('Migration finished.');
}

migrate();
