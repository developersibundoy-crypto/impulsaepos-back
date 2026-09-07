const mysql = require('mysql2');
const conn = mysql.createConnection({host: 'localhost', user: 'root', password: '', database: 'tienda_db'});
conn.query(`CREATE TABLE IF NOT EXISTS cambios_factura (
  id INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id INT NOT NULL,
  factura_original_id INT NOT NULL,
  cajero_id INT,
  producto_devuelto_id INT NOT NULL,
  producto_nuevo_id INT NOT NULL,
  cantidad_devuelta INT NOT NULL,
  cantidad_nueva INT NOT NULL,
  valor_original DECIMAL(15,2) NOT NULL,
  valor_nuevo DECIMAL(15,2) NOT NULL,
  saldo_adicional DECIMAL(15,2) NOT NULL,
  metodo_pago VARCHAR(50) NOT NULL,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  FOREIGN KEY (factura_original_id) REFERENCES facturas_venta(id) ON DELETE CASCADE,
  FOREIGN KEY (producto_devuelto_id) REFERENCES productos(id) ON DELETE CASCADE,
  FOREIGN KEY (producto_nuevo_id) REFERENCES productos(id) ON DELETE CASCADE,
  FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE SET NULL
)`, (err) => {
  if (err) console.error(err);
  else console.log('Table created successfully');
  conn.end();
});
