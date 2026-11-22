// node tests/etapa1/ultima-unidad-local.cjs (instancia de ensayo local en 33317).
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const mysql=require('mysql2/promise'), express=require('express'), jwt=require('jsonwebtoken');
async function main(){
  const password=process.env.ENSAYO_DB_PASSWORD;
  if(!password)throw Error('Se requiere ENSAYO_DB_PASSWORD');
  const name='ensayo_stock_'+crypto.randomBytes(8).toString('hex');
  const db=await mysql.createConnection({host:'127.0.0.1',port:33317,user:'root',password,multipleStatements:true});
  let created=false,server,pool;
  try{
    const [[v]]=await db.query('SELECT @@port puerto,VERSION() version');
    assert.equal(v.puerto,33317);assert.match(v.version,/^11\.8\.9-MariaDB/);
    await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);created=true;
    await db.query(`USE \`${name}\``);
    await db.query(fs.readFileSync(path.resolve(__dirname,'../../../PLAN tienda/dbcompleta.sql'),'utf8'));
    Object.assign(process.env,{DB_HOST:'127.0.0.1',DB_PORT:'33317',DB_USER:'root',DB_PASSWORD:password,DB_NAME:name,JWT_SECRET:crypto.randomBytes(32).toString('hex')});
    require('ts-node/register/transpile-only');
    pool=require('../../src/conection').default.promise();
    const app=express();app.use(express.json());
    for(const [route,module] of [['pos','ventas'],['web','tiendaPublica'],['sep','separados'],['admin','tiendaAdmin']])app.use('/'+route,require('../../src/routes/'+module).default);
    await new Promise(r=>{server=app.listen(0,'127.0.0.1',r);});
    const token=jwt.sign({empresa_id:1,role:'admin',permisos:'all',username:'ensayo'},process.env.JWT_SECRET);
    await db.query(`INSERT INTO empresas_suscritas(id,nombre_comercial,fecha_vencimiento_suscripcion) VALUES(1,'Ensayo','2099-01-01');
      INSERT INTO empresa_config(empresa_id,nombre_empresa,permitir_venta_negativa) VALUES(1,'Ensayo',1);
      INSERT INTO clientes(id,empresa_id,nombre) VALUES(1,1,'Ensayo');
      INSERT INTO tiendas(id,empresa_id,slug,nombre,estado) VALUES(1,1,'ensayo','Ensayo','publicada');
      INSERT INTO tienda_contrataciones(empresa_id,desde,vence_en,estado) VALUES(1,CURRENT_DATE(),'2099-01-01','vigente')`);
    const insertar=async(publicado=true)=>{
      const [r]=await db.query("INSERT INTO productos(empresa_id,nombre,categoria,cantidad,precio_compra,precio_venta,permitir_venta_negativa) VALUES(1,'Unidad','Ensayo',1,1,2,1)");
      if(publicado)await db.query('INSERT INTO tienda_publicaciones(tienda_id,empresa_id,producto_id) VALUES(1,1,?)',[r.insertId]);
      return r.insertId;
    };
    async function post(tipo,id,n=1){
      const item={id,qty:n,precio_venta:2};
      const data=tipo==='pos'?{items:[item],total:2,metodoPago:'Efectivo'}:
        tipo==='sep'?{cliente_id:1,detalles:[item],total:2}:{clave_idempotencia:crypto.randomUUID(),cliente_nombre:'Ensayo',cliente_telefono:'0000000',items:[{producto_id:id,cantidad:n}]};
      const r=await fetch(`http://127.0.0.1:${server.address().port}/${tipo==='web'?'web/ensayo/pedidos':tipo}`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(data)});
      return {status:r.status,body:await r.json()};
    }
    for(const canales of [['web','pos'],['pos','sep'],['sep','web'],['pos','web','sep']]){
      const id=await insertar();
      await db.beginTransaction();
      await db.query('SELECT id FROM productos WHERE id=? FOR UPDATE',[id]);
      const calls=Promise.all(canales.map(k=>post(k,id)));
      try{
        // No soltar la última unidad hasta observar la contención real de todos los compradores.
        const end=Date.now()+10000;let espera=0;
        do{
          const [[r]]=await db.query(`SELECT COUNT(DISTINCT w.requesting_trx_id) n FROM information_schema.INNODB_LOCK_WAITS w
            JOIN information_schema.INNODB_TRX b ON b.trx_id=w.blocking_trx_id WHERE b.trx_mysql_thread_id=CONNECTION_ID()`);
          espera=r.n;if(espera<canales.length)await new Promise(r=>setTimeout(r,100));
        }while(espera<canales.length&&Date.now()<end);
        assert.equal(espera,canales.length);
      }finally{await db.rollback();}
      const rs=await calls;assert.equal(rs.filter(r=>r.status===201).length,1,JSON.stringify(rs));
      for(const r of rs.filter(r=>r.status!==201)){assert([400,409].includes(r.status));assert.match(JSON.stringify(r.body),/stock insuficiente|stock_insuficiente/i);}
      const [[p]]=await db.query('SELECT cantidad FROM productos WHERE id=?',[id]);assert.equal(p.cantidad,0);
      const [k]=await db.query('SELECT cantidad_antes,cantidad_despues FROM kardex WHERE producto_id=?',[id]);assert.deepEqual(k,[{cantidad_antes:1,cantidad_despues:0}]);
      console.log('OK',canales.join(' / '));
    }
    const id=await insertar(false);
    for(const canal of ['pos','sep','web'])assert.equal((await post(canal,id,'1.5')).status,400);
    assert.equal((await post('pos',id,2)).status,201,'Venta negativa interna autorizada');
    console.log('OK validación de cantidades y venta negativa no publicada');
    const {liberarReservasVencidas}=require('../../src/services/tiendaReservasWorker');
    const base=`http://127.0.0.1:${server.address().port}`;
    async function pedido(n){
      const ids=[];
      for(let i=0;i<n;i++)ids.push(await insertar());
      const r=await fetch(base+'/web/ensayo/pedidos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clave_idempotencia:crypto.randomUUID(),cliente_nombre:'Ensayo',cliente_telefono:'0000000',items:ids.map(producto_id=>({producto_id,cantidad:1}))})});
      assert.equal(r.status,201);return {ids,id:(await r.json()).pedido.id};
    }
    const estado=(id,nuevo_estado)=>fetch(base+`/admin/pedidos/${id}/estado`,{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({nuevo_estado})});
    const vencer=id=>db.execute('UPDATE tienda_pedidos SET fecha_limite_pago=NOW()-INTERVAL 1 MINUTE WHERE id=?',[id]);
    async function comprobar(p,stock,final,reservas,entradas){
      const [[order]]=await db.execute('SELECT estado FROM tienda_pedidos WHERE id=?',[p.id]);assert.equal(order.estado,final);
      const [ps]=await db.query('SELECT cantidad FROM productos WHERE id IN (?)',[p.ids]);assert.equal(ps.length,p.ids.length);assert(ps.every(r=>r.cantidad===stock));
      const [rs]=await db.execute('SELECT estado FROM tienda_reservas WHERE pedido_id=?',[p.id]);assert.equal(rs.length,p.ids.length);assert(rs.every(r=>reservas.includes(r.estado)));assert.equal(new Set(rs.map(r=>r.estado)).size,1);
      const [ks]=await db.query("SELECT producto_id,cantidad_antes,cantidad_despues FROM kardex WHERE producto_id IN (?) AND tipo_movimiento='ENTRADA'",[p.ids]);assert.equal(ks.length,entradas);assert.equal(new Set(ks.map(k=>k.producto_id)).size,entradas);assert(ks.every(k=>k.cantidad_antes===0&&k.cantidad_despues===1));
    }
    const a=await pedido(30),b=await pedido(30);
    await vencer(a.id);await vencer(b.id);
    const liberadas=await Promise.all([liberarReservasVencidas(),liberarReservasVencidas()]);
    assert.equal(liberadas[0]+liberadas[1],60);assert.equal(await liberarReservasVencidas(),0);
    for(const p of [a,b])await comprobar(p,1,'cancelado',['liberada'],30);
    const c=await pedido(3);await vencer(c.id);
    const [cancel]=await Promise.all([estado(c.id,'cancelado'),liberarReservasVencidas()]);
    assert.equal(cancel.status,200);assert.equal((await estado(c.id,'cancelado')).status,200);
    await comprobar(c,1,'cancelado',['cancelada','liberada'],3);
    const d=await pedido(1);
    for(const s of ['confirmado','listo_recogida','entregado'])assert.equal((await estado(d.id,s)).status,200);
    assert.equal((await estado(d.id,'cancelado')).status,409);await comprobar(d,0,'entregado',['consolidada'],0);
    const f=await pedido(2);await vencer(f.id);
    // Simular una referencia histórica huérfana después de una primera línea válida.
    await db.execute('UPDATE tienda_reservas SET producto_id=2147483647 WHERE pedido_id=? AND producto_id=?',[f.id,f.ids[1]]);
    assert.equal(await liberarReservasVencidas(),0);await comprobar(f,0,'pendiente',['activa'],0);
    await db.execute('UPDATE tienda_reservas SET producto_id=? WHERE pedido_id=? AND producto_id=2147483647',[f.ids[1],f.id]);
    assert.equal(await liberarReservasVencidas(),2);await comprobar(f,1,'cancelado',['liberada'],2);
    console.log('OK 60 reservas, trabajadores concurrentes, cancelación repetida, entrega terminal, rollback y recuperación');
    const unidad=await insertar(),key=crypto.randomUUID();
    const payload={clave_idempotencia:key,cliente_nombre:'Ensayo',cliente_telefono:'0000000',items:[{producto_id:unidad,cantidad:1}]};
    const enviar=async(body)=>{const r=await fetch(base+'/web/ensayo/pedidos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
    const envios=await Promise.all(Array.from({length:6},()=>enviar(payload)));
    assert.deepEqual(envios.map(x=>x.status).sort(),[200,200,200,200,200,201]);
    assert.equal(new Set(envios.map(x=>x.data.pedido.token_seguimiento)).size,1);
    const replay=await enviar(payload);assert.equal(replay.status,200);assert.equal(replay.data.pedido.id,envios[0].data.pedido.id);
    const conflicto=await enviar({...payload,cliente_telefono:'1111111'});assert.equal(conflicto.status,409);assert(!conflicto.data.pedido);
    assert.equal((await enviar({...payload,clave_idempotencia:null})).status,400);
    const [[persistido]]=await db.execute(`SELECT (SELECT COUNT(*) FROM tienda_pedidos WHERE tienda_id=1 AND clave_idempotencia=?) pedidos,
      (SELECT COUNT(*) FROM tienda_reservas WHERE producto_id=?) reservas,(SELECT COUNT(*) FROM kardex WHERE producto_id=?) movimientos,
      (SELECT cantidad FROM productos WHERE id=?) stock`,[key,unidad,unidad,unidad]);
    assert.deepEqual(persistido,{pedidos:1,reservas:1,movimientos:1,stock:0});
    console.log('OK seis envíos concurrentes, recuperación de respuesta, conflicto de contenido y reserva única');
  }finally{
    if(server)await new Promise(r=>server.close(r));
    if(pool)await pool.end();
    if(created)await db.query(`DROP DATABASE \`${name}\``);
    await db.end();
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
