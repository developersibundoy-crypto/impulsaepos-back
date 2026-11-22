// node tests/etapa1/permisos-tienda-local.cjs (instancia de ensayo local en 33317; requiere ENSAYO_DB_PASSWORD).
// Verifica la autorización por operación en /tienda-admin: operador vs. dueño/administrador, sin tocar stock al denegar.
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const mysql=require('mysql2/promise'), express=require('express'), jwt=require('jsonwebtoken');
async function main(){
  const password=process.env.ENSAYO_DB_PASSWORD;
  if(!password)throw Error('Se requiere ENSAYO_DB_PASSWORD');
  const name='ensayo_permisos_'+crypto.randomBytes(8).toString('hex');
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
    for(const [route,module] of [['web','tiendaPublica'],['admin','tiendaAdmin']])app.use('/'+route,require('../../src/routes/'+module).default);
    await new Promise(r=>{server=app.listen(0,'127.0.0.1',r);});
    const base=`http://127.0.0.1:${server.address().port}`;
    const firmar=(p)=>jwt.sign({username:'u',...p},process.env.JWT_SECRET);
    const T={
      dueno:firmar({id:1,empresa_id:1,role:'admin',permisos:'all'}),
      adminVacio:firmar({id:2,empresa_id:1,role:'admin',permisos:null}),
      cajeroAdmin:firmar({id:3,empresa_id:1,role:'cajero',permisos:JSON.stringify(['tienda_admin'])}),
      operador:firmar({id:4,empresa_id:1,role:'cajero',permisos:JSON.stringify(['tienda_operacion'])}),
      configuracion:firmar({id:5,empresa_id:1,role:'cajero',permisos:JSON.stringify(['configuracion','venta'])}),
      otraEmpresa:firmar({id:6,empresa_id:2,role:'admin',permisos:'all'}),
    };
    await db.query(`INSERT INTO empresas_suscritas(id,nit,nombre_comercial,fecha_vencimiento_suscripcion) VALUES(1,'900000001','Ensayo','2099-01-01'),(2,'900000002','Otra','2099-01-01');
      INSERT INTO empresa_config(empresa_id,nombre_empresa,permitir_venta_negativa) VALUES(1,'Ensayo',0),(2,'Otra',0);
      INSERT INTO tiendas(id,empresa_id,slug,nombre,estado) VALUES(1,1,'ensayo','Ensayo','publicada');
      INSERT INTO tienda_contrataciones(empresa_id,desde,vence_en,estado) VALUES(1,CURRENT_DATE(),'2099-01-01','vigente')`);
    const [pr]=await db.query("INSERT INTO productos(empresa_id,nombre,categoria,cantidad,precio_compra,precio_venta) VALUES(1,'Item','Ensayo',50,1,2)");
    await db.query('INSERT INTO tienda_publicaciones(tienda_id,empresa_id,producto_id) VALUES(1,1,?)',[pr.insertId]);
    const productoBase=pr.insertId;
    const llamar=async(method,ruta,token,body)=>{
      const r=await fetch(base+ruta,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      let data=null;try{data=await r.json();}catch(e){}
      return {status:r.status,data};
    };
    // Cada pedido usa su propio producto para que stock y kardex sean aislables.
    async function pedido(){
      const [p]=await db.query("INSERT INTO productos(empresa_id,nombre,categoria,cantidad,precio_compra,precio_venta) VALUES(1,'Item','Ensayo',3,1,2)");
      await db.query('INSERT INTO tienda_publicaciones(tienda_id,empresa_id,producto_id) VALUES(1,1,?)',[p.insertId]);
      const r=await llamar('POST','/web/ensayo/pedidos',null,{clave_idempotencia:crypto.randomUUID(),cliente_nombre:'Ensayo',cliente_telefono:'0000000',items:[{producto_id:p.insertId,cantidad:1}]});
      assert.equal(r.status,201,JSON.stringify(r.data));
      return {id:r.data.pedido.id,producto:p.insertId};
    }
    const foto=async(p)=>{
      const [[o]]=await db.execute('SELECT estado FROM tienda_pedidos WHERE id=?',[p.id]);
      const [[s]]=await db.execute('SELECT cantidad FROM productos WHERE id=?',[p.producto]);
      const [rs]=await db.execute('SELECT estado FROM tienda_reservas WHERE pedido_id=?',[p.id]);
      const [[k]]=await db.execute('SELECT COUNT(*) n FROM kardex WHERE producto_id=?',[p.producto]);
      return {estado:o.estado,stock:s.cantidad,reservas:rs.map(r=>r.estado),kardex:k.n};
    };
    const denegados=async(id)=>(await db.execute("SELECT COUNT(*) n FROM tienda_auditoria WHERE entidad='pedido' AND entidad_id=? AND accion='cambio_estado_denegado'",[id]))[0][0].n;
    const estado=(id,token,nuevo_estado)=>llamar('PUT',`/admin/pedidos/${id}/estado`,token,{nuevo_estado});

    // 1. Sin sesión o sin permisos de tienda
    assert.equal((await llamar('GET','/admin/pedidos',null)).status,403);
    for(const [m,ruta,body] of [['GET','/admin/pedidos'],['GET','/admin/mi-tienda'],['GET','/admin/productos'],['PUT','/admin/mi-tienda',{nombre:'Hack tienda'}],
      ['POST','/admin/mi-tienda/estado',{nuevo_estado:'pausada'}],['POST','/admin/mi-tienda/activar-prueba'],
      ['POST','/admin/publicaciones/toggle',{producto_id:productoBase,publicar:false}],['PUT',`/admin/publicaciones/${productoBase}`,{titulo:'x'}]]){
      assert.equal((await llamar(m,ruta,T.configuracion,body)).status,403,'sin módulos de tienda: '+m+' '+ruta);
    }
    console.log('OK sin sesión / sin permisos de tienda: 403 en todas las rutas (el módulo configuracion ya no basta)');

    // 2. Operador: solo lectura de pedidos y avance operativo
    assert.equal((await llamar('GET','/admin/pedidos',T.operador)).status,200);
    assert.equal((await llamar('GET','/admin/mi-tienda',T.operador)).status,200);
    for(const [m,ruta,body] of [['GET','/admin/productos'],['PUT','/admin/mi-tienda',{nombre:'Hack tienda'}],
      ['POST','/admin/mi-tienda/estado',{nuevo_estado:'pausada'}],['POST','/admin/mi-tienda/activar-prueba'],
      ['POST','/admin/publicaciones/toggle',{producto_id:productoBase,publicar:false}],['PUT',`/admin/publicaciones/${productoBase}`,{titulo:'x'}]]){
      assert.equal((await llamar(m,ruta,T.operador,body)).status,403,'operador: '+m+' '+ruta);
    }
    const [[t]]=await db.query("SELECT estado,nombre FROM tiendas WHERE id=1");assert.deepEqual(t,{estado:'publicada',nombre:'Ensayo'});
    const [[pub]]=await db.query('SELECT COUNT(*) n FROM tienda_publicaciones WHERE producto_id=?',[productoBase]);assert.equal(pub.n,1);
    console.log('OK operador: lee pedidos y tienda; configuración, catálogo, publicación y prueba denegados sin cambios');

    // 3. Operador no valida pagos ni cancela; stock y kardex no cambian
    const a=await pedido();const antes=await foto(a);
    assert.deepEqual(antes,{estado:'pendiente',stock:2,reservas:['activa'],kardex:1});
    assert.equal((await estado(a.id,T.operador,'confirmado')).status,403);
    assert.equal((await estado(a.id,T.operador,'cancelado')).status,403);
    assert.deepEqual(await foto(a),antes);assert.equal(await denegados(a.id),2);
    assert.equal((await estado(a.id,T.operador,'listo_recogida')).status,409,'no puede saltarse la validación de pago');
    assert.deepEqual(await foto(a),antes);
    // 4. Dueño valida; operador avanza y entrega; entrega no repone stock
    assert.equal((await estado(a.id,T.dueno,'confirmado')).status,200);
    assert.equal((await estado(a.id,T.operador,'listo_recogida')).status,200);
    assert.equal((await estado(a.id,T.operador,'entregado')).status,200);
    assert.deepEqual(await foto(a),{estado:'entregado',stock:2,reservas:['consolidada'],kardex:1});
    assert.equal((await estado(a.id,T.dueno,'cancelado')).status,409);
    assert.deepEqual(await foto(a),{estado:'entregado',stock:2,reservas:['consolidada'],kardex:1});
    console.log('OK operador denegado (403) en pago/cancelación sin tocar inventario; flujo dueño→operador→entrega consistente');

    // 5. Un pedido ya confirmado tampoco lo cancela el operador
    const b=await pedido();assert.equal((await estado(b.id,T.adminVacio,'confirmado')).status,200);
    const bAntes=await foto(b);assert.equal((await estado(b.id,T.operador,'cancelado')).status,403);assert.deepEqual(await foto(b),bAntes);
    // 6. Cancelación concurrente: operador denegado y dueño permitido; una sola reposición
    const c=await pedido();
    const rs=await Promise.all([estado(c.id,T.operador,'cancelado'),estado(c.id,T.dueno,'cancelado'),estado(c.id,T.operador,'cancelado')]);
    assert.deepEqual(rs.map(r=>r.status),[403,200,403]);
    assert.deepEqual(await foto(c),{estado:'cancelado',stock:3,reservas:['cancelada'],kardex:2});
    assert.equal((await estado(c.id,T.cajeroAdmin,'cancelado')).status,200,'repetición idempotente');
    assert.deepEqual(await foto(c),{estado:'cancelado',stock:3,reservas:['cancelada'],kardex:2});
    console.log('OK cancelación concurrente operador vs. dueño: una sola reposición y kardex consistente');

    // 7. Administrador por módulo explícito y dueño pueden administrar; otra empresa no ve ni toca
    assert.equal((await llamar('PUT','/admin/mi-tienda',T.cajeroAdmin,{nombre:'Ensayo Tienda',slug:'ensayo'})).status,200);
    assert.equal((await llamar('GET','/admin/productos',T.dueno)).status,200);
    const d=await pedido();const dAntes=await foto(d);
    assert.equal((await estado(d.id,T.otraEmpresa,'cancelado')).status,404);assert.deepEqual(await foto(d),dAntes);
    const lista=await llamar('GET','/admin/pedidos',T.otraEmpresa);assert.equal(lista.status,200);assert.equal(lista.data.pedidos.length,0);
    assert.equal((await estado(d.id,T.cajeroAdmin,'confirmado')).status,200);
    console.log('OK administrador por módulo y dueño operan; otra empresa recibe 404/lista vacía sin cambios');
  }finally{
    if(server)await new Promise(r=>server.close(r));
    if(pool)await pool.end();
    if(created)await db.query(`DROP DATABASE \`${name}\``);
    await db.end();
  }
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
