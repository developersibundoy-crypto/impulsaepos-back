'use strict';

const {
  addColumnIfMissing,
  columnExists,
} = require('./_lib.cjs');

module.exports = {
  version: '20261120_004_tienda_banner',
  description: 'Campos para personalización visual avanzada: banner_url y tagline promocional en tiendas',
  tables: ['tiendas'],

  async up(conn) {
    await addColumnIfMissing(conn, 'tiendas', 'banner_url', 'VARCHAR(500) NULL');
    await addColumnIfMissing(conn, 'tiendas', 'tagline', 'VARCHAR(160) NULL');
  },

  async verify(conn) {
    if (!(await columnExists(conn, 'tiendas', 'banner_url'))) {
      throw new Error('Verificación fallida: falta columna banner_url en tiendas');
    }
    if (!(await columnExists(conn, 'tiendas', 'tagline'))) {
      throw new Error('Verificación fallida: falta columna tagline en tiendas');
    }
  },
};
