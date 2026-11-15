// MIRAFIT: سرور پرداخت (زرین‌پال) + ایمیل + صندوق سفارش. اجرا: npm install && node server.js
const express=require('express'),compression=require('compression'),nodemailer=require('nodemailer'),{Pool}=require('pg'),fs=require('fs'),crypto=require('crypto');
const {ZARINPAL_MERCHANT,BASE_URL,ADMIN_PASSWORD,DATABASE_URL,SMTP_HOST,SMTP_PORT,SMTP_USER,SMTP_PASS,MAIL_FROM,SHOP_EMAIL,PORT=3000}=process.env;
if(!ZARINPAL_MERCHANT||!BASE_URL||!ADMIN_PASSWORD||!DATABASE_URL)console.warn('هشدار: ZARINPAL_MERCHANT / BASE_URL / ADMIN_PASSWORD / DATABASE_URL تنظیم نشده‌اند.');
const HTML=__dirname+'/index.html',RIAL=10,app=express(),cardHits={};
// ذخیره‌سازی دائمی در دیتابیس Postgres (مثلاً Neon رایگان): جدول ساده کلید/مقدار
const pool=new Pool({connectionString:DATABASE_URL,ssl:DATABASE_URL&&!/localhost|127\.0\.0\.1/.test(DATABASE_URL)?{rejectUnauthorized:false}:false});
const kvGet=async k=>(await pool.query('SELECT value FROM kv WHERE key=$1',[k])).rows[0]?.value;
const kvSet=(k,v)=>pool.query('INSERT INTO kv(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated=now()',[k,JSON.stringify(v)]);
const getOrder=id=>kvGet('order:'+String(id).slice(0,64)),putOrder=o=>kvSet('order:'+o.id,o);
const listOrders=async()=>(await pool.query("SELECT value FROM kv WHERE key LIKE 'order:%' ORDER BY (value->>'t')::bigint DESC LIMIT 500")).rows.map(r=>r.value);
const mailer=nodemailer.createTransport({host:SMTP_HOST,port:+SMTP_PORT||465,secure:(+SMTP_PORT||465)===465,auth:{user:SMTP_USER,pass:SMTP_PASS}});
const T=n=>Number(n).toLocaleString('fa-IR')+' تومان',E=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
//#pricing  کاتالوگ و قیمت‌ها از دیتابیس سرور خوانده می‌شوند (نه از مرورگر مشتری)
let CAT=null;
function seed(){const h=fs.readFileSync(HTML,'utf8'),a='<script id="data" type="application/json">',i=h.indexOf(a)+a.length;return JSON.parse(h.slice(i,h.indexOf('</script>',i)))}
async function catalog(){return CAT||(CAT=(await kvGet('catalog'))||seed())}
function price(items,method,C){if(!Array.isArray(items)||!items.length||items.length>50)throw'سبد خرید نامعتبر است.';let sub=0;const out=[];
  for(const it of items){const p=C.products.find(x=>x.id===it.id),q=Math.floor(+it.q);if(!p||!(q>=1&&q<=99))throw'کالا نامعتبر است.';
    const vs=p.variants&&p.variants.length?p.variants:[{color:'',size:'',price:p.price,stock:99}],v=vs.find(x=>(x.color||'')===(it.color||'')&&(x.size||'')===(it.size||''));
    if(!v||!(+v.price>0))throw'کالا نامعتبر است.';if(q>+(v.stock??99))throw`موجودی «${p.name}» کافی نیست.`;
    sub+=v.price*q;out.push({id:p.id,name:p.name,color:v.color||'',size:v.size||'',price:+v.price,q})}
  const sh=method==='pickup'?0:((+C.shop.freeFrom>0&&sub>=+C.shop.freeFrom)?0:Math.max(0,+C.shop.shipping||0));
  return{items:out,sub,ship:sh,total:sub+sh,shop:C.shop}}
//#end
const zp=(p,b)=>fetch('https://payment.zarinpal.com/pg/v4/payment/'+p+'.json',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({merchant_id:ZARINPAL_MERCHANT,...b})}).then(r=>r.json());
const where=o=>o.m==='pickup'?'دریافت حضوری از فروشگاه':`${o.a} · کد پستی ${o.z}`;
function invoiceHtml(o,shop){return `<div dir="rtl" style="font-family:Tahoma"><h2>${E(shop.name)}</h2><p>فاکتور ${E(o.no)} · ${E(o.d)}</p><p><b>خریدار:</b> ${E(o.b.n)} · ${E(o.b.p)}<br><b>تحویل:</b> ${E(where(o))}</p><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>کالا</th><th>تعداد</th><th>قیمت</th></tr>${o.items.map(i=>`<tr><td>${E(i.name)} ${E(i.color)} ${E(i.size)}</td><td>${i.q}</td><td>${T(i.price*i.q)}</td></tr>`).join('')}</table><p>جمع کالاها: ${T(o.sub)}<br>هزینه ارسال: ${o.ship?T(o.ship):'رایگان'}<br><b>مبلغ پرداخت‌شده: ${T(o.total)}</b><br>کد پیگیری پرداخت: ${E(o.ref)}</p><p>وضعیت سفارش: در انتظار تأیید. پس از ${o.m==='pickup'?'آماده شدن':'ارسال'} سفارش، ایمیل جدیدی برایتان می‌فرستیم.</p></div>`}
app.set('trust proxy',1);app.use(compression());
const fails={};const sha=s=>crypto.createHash('sha256').update(String(s)).digest();
function admin(req,res,next){const ip=req.ip,f=fails[ip]||{n:0,t:Date.now()};if(Date.now()-f.t>9e5){f.n=0;f.t=Date.now()}
  if(f.n>=10)return res.status(429).json({error:'تلاش زیاد؛ بعداً امتحان کنید.'});
  if(!ADMIN_PASSWORD||!crypto.timingSafeEqual(sha(req.get('x-admin')||''),sha(ADMIN_PASSWORD))){f.n++;fails[ip]=f;return res.status(401).json({error:'unauthorized'})}next()}
app.post('/api/admin/catalog',admin,express.json({limit:'25mb'}),async(req,res)=>{try{const d=req.body?.data;
  if(!d||!Array.isArray(d.products)||d.products.length>500||!d.shop||typeof d.shop!=='object'||d.products.some(p=>!p||typeof p.id!=='string'||typeof p.name!=='string'))return res.status(400).json({error:'داده نامعتبر است.'});
  await kvSet('catalog',d);CAT=d;res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'ذخیره در دیتابیس ناموفق بود.'})}});
app.use(express.json({limit:'1mb'}));
app.post('/api/checkout',async(req,res)=>{try{
  const {b,m,a,z,items,pay,ref,receipt}=req.body||{},ok=s=>typeof s==='string'&&s.length>0&&s.length<300;
  if(!b||!ok(b.n)||!ok(b.p)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.e||'')||!['post','pickup'].includes(m)||(m==='post'&&(!ok(a)||!/^\d{10}$/.test(z||''))))return res.status(400).json({error:'اطلاعات واردشده کامل نیست.'});
  let P;try{P=price(items,m,await catalog())}catch(e){if(typeof e==='string')return res.status(400).json({error:e});throw e}
  if(pay==='card'){const C=await catalog();if(!/\d{12}/.test(String(C.shop.cardNo||'')))return res.status(400).json({error:'کارت‌به‌کارت فعال نیست.'});
    const refS=typeof ref==='string'?ref.trim():'',rcOk=typeof receipt==='string'&&receipt.length<900000&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(receipt);
    if(refS.length>40||(receipt&&!rcOk))return res.status(400).json({error:'اطلاعات پرداخت یا تصویر فیش نامعتبر است.'});
    if(refS.length<3&&!rcOk)return res.status(400).json({error:'شمارهٔ پیگیری را بنویسید یا تصویر فیش را ضمیمه کنید.'});
    const now=Date.now();cardHits[req.ip]=(cardHits[req.ip]||[]).filter(t=>now-t<36e5);if(cardHits[req.ip].length>=10)return res.status(429).json({error:'تعداد درخواست زیاد است؛ بعداً تلاش کنید.'});cardHits[req.ip].push(now);
    const id=crypto.randomUUID(),no='INV-'+String(now).slice(-8);
    await putOrder({id,no,d:new Date().toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran'}),b:{n:b.n,p:b.p,e:b.e},m,a:m==='post'?a:'',z:m==='post'?z:'',items:P.items,sub:P.sub,ship:P.ship,total:P.total,paid:false,pay:'card',cref:refS,receipt:rcOk?receipt:null,status:'awaiting',t:now});
    if(SHOP_EMAIL)mailer.sendMail({from:MAIL_FROM||SMTP_USER,to:SHOP_EMAIL,subject:`سفارش کارت‌به‌کارت ${no} در انتظار تأیید`,text:`${b.n} - ${b.p}\nمبلغ: ${T(P.total)}\nمرجع پرداخت: ${refS||'—'}${rcOk?' (تصویر فیش دارد)':''}\nتأیید از «صندوق سفارش‌ها» در پنل مدیر.`}).catch(e=>console.error('mail',e));
    return res.json({card:true,id})}
  const id=crypto.randomUUID(),no='INV-'+Date.now().toString().slice(-8),r=await zp('request',{amount:P.total*RIAL,callback_url:`${BASE_URL}/api/callback?o=${id}`,description:'سفارش '+no,metadata:{mobile:b.p,email:b.e}});
  if(r.data?.code!==100)return res.status(502).json({error:'اتصال به درگاه برقرار نشد.'});
  await putOrder({id,no,d:new Date().toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran'}),b:{n:b.n,p:b.p,e:b.e},m,a:m==='post'?a:'',z:m==='post'?z:'',items:P.items,sub:P.sub,ship:P.ship,total:P.total,authority:r.data.authority,paid:false,status:'unpaid',t:Date.now()});
  res.json({url:'https://payment.zarinpal.com/pg/StartPay/'+r.data.authority});
}catch(e){console.error(e);res.status(500).json({error:'خطای سرور؛ دوباره تلاش کنید.'})}});
app.get('/api/callback',async(req,res)=>{try{const id=String(req.query.o||''),o=await getOrder(id);
  if(!o||req.query.Authority!==o.authority||req.query.Status!=='OK')return res.redirect(`/?order=${encodeURIComponent(id||'x')}&paid=0`);
  if(!o.paid){const v=await zp('verify',{amount:o.total*RIAL,authority:o.authority});
    if(![100,101].includes(v.data?.code))return res.redirect(`/?order=${id}&paid=0`);
    o.paid=true;o.status='pending';o.ref=String(v.data.ref_id);await putOrder(o);
    mailer.sendMail({from:MAIL_FROM||SMTP_USER,to:o.b.e,bcc:SHOP_EMAIL,subject:`فاکتور و تأیید پرداخت سفارش ${o.no}`,html:invoiceHtml(o,(await catalog()).shop)}).catch(e=>console.error('mail',e))}
  res.redirect(`/?order=${id}&paid=1`)}catch(e){console.error(e);res.redirect('/?order=x&paid=0')}});
app.get('/api/order/:id',async(req,res)=>{try{const o=await getOrder(req.params.id);if(!o||(!o.paid&&o.status!=='awaiting'))return res.json({paid:false});const{authority,receipt,...pub}=o;res.json(pub)}catch(e){res.json({paid:false})}});
app.get('/api/catalog',async(req,res)=>{try{res.set('Cache-Control','no-cache');res.json({data:await catalog()})}catch(e){console.error(e);res.status(500).json({})}});
app.post('/api/admin/ping',admin,(req,res)=>res.json({ok:true}));
app.post('/api/admin/confirm',admin,async(req,res)=>{try{const o=await getOrder(req.body?.id||'');if(!o||o.status!=='awaiting')return res.status(404).json({error:'سفارش در انتظار تأیید پیدا نشد.'});
  o.paid=true;o.status='pending';o.ref='کارت‌به‌کارت'+(o.cref?' - '+o.cref:'');await putOrder(o);let mailed=true;
  try{await mailer.sendMail({from:MAIL_FROM||SMTP_USER,to:o.b.e,bcc:SHOP_EMAIL,subject:`فاکتور و تأیید پرداخت سفارش ${o.no}`,html:invoiceHtml(o,(await catalog()).shop)})}catch(e){console.error('mail',e);mailed=false}
  res.json({ok:true,mailed})}catch(e){console.error(e);res.status(500).json({error:'خطای سرور'})}});
app.post('/api/admin/receipt',admin,async(req,res)=>{try{const o=await getOrder(req.body?.id||'');res.json({data:o&&o.receipt||null})}catch(e){res.status(500).json({error:'خطا'})}});
app.post('/api/admin/orders',admin,async(req,res)=>{try{res.json({orders:(await listOrders()).filter(o=>o.paid||o.status==='awaiting').map(({authority,receipt,...o})=>({...o,hasReceipt:!!receipt}))})}catch(e){console.error(e);res.status(500).json({error:'خطای دیتابیس'})}});
app.post('/api/admin/ship',admin,async(req,res)=>{const o=await getOrder(req.body?.id||'');if(!o||!o.paid)return res.status(404).json({error:'not found'});
  const code=String(req.body.code||'').trim().slice(0,100),pick=o.m==='pickup';if(!pick&&!code)return res.status(400).json({error:'کد رهگیری لازم است.'});
  o.status=pick?'ready':'shipped';o.code=code;await putOrder(o);let mailed=true;
  try{await mailer.sendMail({from:MAIL_FROM||SMTP_USER,to:o.b.e,bcc:SHOP_EMAIL,subject:pick?`سفارش ${o.no} آماده تحویل است`:`سفارش ${o.no} ارسال شد`,html:`<div dir="rtl" style="font-family:Tahoma"><p>${E(o.b.n)} عزیز،</p>${pick?'<p>سفارش شما آماده تحویل حضوری است.</p>':`<p>سفارش شما با پست ارسال شد.</p><p><b>کد رهگیری: ${E(code)}</b></p>`}<p>شماره سفارش: ${E(o.no)}</p></div>`})}catch(e){console.error('mail',e);mailed=false}
  res.json({ok:true,mailed})});
app.get('/',(q,r)=>r.sendFile(HTML));
pool.query('CREATE TABLE IF NOT EXISTS kv(key text PRIMARY KEY,value jsonb NOT NULL,updated timestamptz DEFAULT now())').then(()=>app.listen(PORT,()=>console.log('http://localhost:'+PORT))).catch(e=>{console.error('خطای اتصال به دیتابیس:',e.message);process.exit(1)});
