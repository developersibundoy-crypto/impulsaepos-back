'use strict';
const {addColumnIfMissing,addIndexIfMissing,assertUniqueIndex,columnExists}=require('./_lib.cjs');
const tabla='tienda_pedidos', indice='uq_pedido_tienda_intento';
module.exports={
  version:'20261122_005_checkout_idempotente',
  description:'Un intento de checkout por tienda y huella del contenido confirmado',
  tables:[tabla],
  async up(conn){
    const [duplicados]=await conn.query(`SELECT 1 FROM tienda_pedidos WHERE clave_idempotencia IS NOT NULL
      GROUP BY tienda_id,clave_idempotencia HAVING COUNT(*)>1 LIMIT 1`);
    if(duplicados.length)throw Error('Hay intentos duplicados por tienda. Conciliar pedidos y reservas antes de migrar; no se han modificado.');
    await addColumnIfMissing(conn,tabla,'huella_checkout','CHAR(64) CHARACTER SET ascii NULL');
    await addIndexIfMissing(conn,tabla,indice,'UNIQUE KEY uq_pedido_tienda_intento (tienda_id,clave_idempotencia)');
  },
  async verify(conn){
    if(!await columnExists(conn,tabla,'huella_checkout'))throw Error('Falta huella_checkout');
    await assertUniqueIndex(conn,tabla,indice,['tienda_id','clave_idempotencia']);
  }
};
