const axios = require('axios');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

async function testApi() {
  const secret = process.env.JWT_SECRET || 'your_jwt_secret_key';
  
  // Create a token for a cajero (e.g., company 1, cajero 1)
  const token = jwt.sign(
    {
      id: 2, // admin user ID
      role: 'admin',
      username: 'admin',
      empresa_id: 1,
      cajero_id: null,
      permisos: null
    },
    secret,
    { expiresIn: '1h' }
  );

  console.log("Generated Token:", token);

  const payload = {
    items: [
      {
        id: 3, // physical product ID 3 (we know it exists from earlier)
        qty: 1,
        precio_venta: 10000,
        descuento: 0
      }
    ],
    metodoPago: 'Efectivo',
    efectivoEntregado: 10000,
    transferenciaEntregada: 0,
    vuelto: 0,
    cajeroId: null,
    clienteId: null,
    total: 10000,
    iva: 0
  };

  try {
    const res = await axios.post('http://localhost:4000/ventas', payload, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    console.log("STATUS:", res.status);
    console.log("RESPONSE DATA:", res.data);
  } catch (err) {
    console.log("ERROR STATUS:", err.response ? err.response.status : "No response");
    console.log("ERROR RESPONSE DATA:", err.response ? err.response.data : err.message);
  }
}

testApi();
