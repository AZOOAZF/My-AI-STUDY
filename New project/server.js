const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { welcome, orderConfirmation, paymentFailed } = require('./email-templates');

const DB = path.join(__dirname, 'data.json');
const PORT = Number(process.env.PORT || 3200);
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:' + PORT;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'AI Bloom <onboarding@resend.dev>';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'test';
const sessions = new Map();

const units = ['Python 基础','Python 实操','大模型原理','LLM 应用','RAG 知识库','Agent 核心','框架部署','作品集项目'];
const links = ['https://liaoxuefeng.com/books/python/introduction/index.html','https://liaoxuefeng.com/books/python/introduction/index.html','https://github.com/datawhalechina/happy-llm','https://github.com/datawhalechina/hello-agents','https://github.com/datawhalechina/hello-agents','https://github.com/datawhalechina/hello-agents','https://ollama.readthedocs.io/quickstart/','https://github.com/datawhalechina/hello-agents'];

function seedTasks() { const a=[]; const start=new Date('2026-09-03'); for(let i=0;i<56;i++){const d=new Date(start);d.setDate(start.getDate()+i);const w=Math.floor(i/7);a.push({id:i+1,date:d.toISOString().slice(0,10),week:w+1,module:units[w],title:i%7===6?'周测与复盘：提交本周成果':units[w]+'：理论、案例与实操',description:i%7===6?'完成可运行小作品，记录一个难点和解决方法':'理论 30 分钟 · 案例 25 分钟 · 实操 55 分钟 · 复盘 20 分钟',minutes:120,resource:links[w]})} return a; }
function load() { try { const d=JSON.parse(fs.readFileSync(DB,'utf8')); d.users??={};d.progress??={};d.notes??={};d.posts??=[];d.products??=[];d.orders??={};d.paymentEvents??={};d.emailJobs??=[];d.tasks=d.tasks?.length?d.tasks:seedTasks(); return d; } catch { return {users:{},progress:{},notes:{},posts:[],products:[],orders:{},paymentEvents:{},emailJobs:[],tasks:seedTasks()}; } }
function save(d) { fs.writeFileSync(DB, JSON.stringify(d,null,2)); }
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
function readBody(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(new Error('JSON 格式错误'))}});req.on('error',reject)})}
function readRaw(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>resolve(s));req.on('error',reject)})}
function auth(req){return sessions.get((req.headers.authorization||'').replace('Bearer ',''));}
function id(prefix){return prefix+'_'+crypto.randomBytes(10).toString('hex');}
function validCurrency(x){return ['usd','cny'].includes(String(x||'').toLowerCase());}
function logError(context,error){console.error(JSON.stringify({time:new Date().toISOString(),context,error:String(error.message||error)}));}
async function sendEmail(to,subject,html,job,d){if(!RESEND_API_KEY){d.emailJobs.push({...job,status:'skipped',reason:'RESEND_API_KEY 未配置',createdAt:new Date().toISOString()});save(d);return false}try{const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:EMAIL_FROM,to:[to],subject,html})});if(!r.ok)throw new Error('Resend '+r.status+' '+await r.text());d.emailJobs.push({...job,status:'sent',createdAt:new Date().toISOString()});save(d);return true}catch(e){logError('email',e);d.emailJobs.push({...job,status:'failed',error:e.message,createdAt:new Date().toISOString()});save(d);return false}}
function verifyStripe(raw,signature){if(!STRIPE_WEBHOOK_SECRET)return false;const parts=Object.fromEntries(String(signature||'').split(',').map(x=>x.split('=')));if(!parts.t||!parts.v1)return false;const expected=crypto.createHmac('sha256',STRIPE_WEBHOOK_SECRET).update(parts.t+'.'+raw).digest('hex');return Math.abs(expected.length-parts.v1.length)===0&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(parts.v1));}
async function stripe(pathname,body){const r=await fetch('https://api.stripe.com/v1/'+pathname,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(STRIPE_SECRET_KEY+':').toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={raw:text}}if(!r.ok)throw new Error('Stripe '+r.status+' '+text);return data;}
function form(obj){return new URLSearchParams(obj).toString();}
function productFor(d,productId,currency,mode){const p=d.products.find(x=>x.id===productId&&x.active!==false&&x.mode===mode&&x.currency===currency);if(!p||!Number.isInteger(p.amount)||p.amount<=0)throw new Error('商品未配置有效价格');return p;}
async function app(req,res){
  const u=new URL(req.url,'http://localhost'); const d=load();
  if(req.method==='GET'&&u.pathname==='/health')return send(res,200,{ok:true,time:new Date().toISOString()});
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res)}
  if(req.method==='GET'&&u.pathname==='/api/tasks')return send(res,200,{tasks:d.tasks});
  if(req.method==='POST'&&u.pathname==='/api/auth/request-code')return send(res,200,{message:'演示验证码：123456'});
  if(req.method==='POST'&&u.pathname==='/api/auth/login'){const b=await readBody(req),email=String(b.email||'').trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email)||b.code!=='123456')return send(res,401,{error:'邮箱或验证码错误'});const token=id('sess');sessions.set(token,{email,role:'user'});const isNew=!d.users[email];d.users[email]??={email,nickname:email.split('@')[0],bio:'正在积累 AI 能力'};save(d);if(isNew)sendEmail(email,'欢迎加入 AI Bloom',welcome(d.users[email]),'welcome:'+email,d);return send(res,200,{token,user:d.users[email]})}
  if(req.method==='POST'&&u.pathname==='/api/admin/login'){const b=await readBody(req);if(b.email!==ADMIN_EMAIL||b.password!==ADMIN_PASSWORD)return send(res,401,{error:'管理员账号或密码错误'});const token=id('sess');sessions.set(token,{email:b.email,role:'admin'});return send(res,200,{token,user:{email:b.email,role:'admin'}})}
  if(req.method==='POST'&&u.pathname==='/api/payments/stripe/webhook'){const raw=await readRaw(req);if(!verifyStripe(raw,req.headers['stripe-signature']))return send(res,400,{error:'webhook 签名无效'});const event=JSON.parse(raw);if(d.paymentEvents[event.id])return send(res,200,{received:true,duplicate:true});d.paymentEvents[event.id]={type:event.type,receivedAt:new Date().toISOString()};const obj=event.data?.object||{};const order=d.orders[obj.metadata?.orderId||obj.client_reference_id];if(order&&(event.type==='checkout.session.completed'||event.type==='invoice.paid')){if(order.status!=='paid'){order.status='paid';order.paidAt=new Date().toISOString();sendEmail(order.userEmail,'订单支付成功',orderConfirmation(order),'order_confirmation:'+order.id,d)}}else if(order&&(event.type==='checkout.session.async_payment_failed'||event.type==='invoice.payment_failed')){order.status='failed';sendEmail(order.userEmail,'支付失败通知',paymentFailed(order),'payment_failed:'+order.id,d)}save(d);return send(res,200,{received:true})}
  const me=auth(req); if(!me)return send(res,401,{error:'请先登录'});
  if(req.method==='GET'&&u.pathname==='/api/me')return send(res,200,{user:d.users[me.email]||me});
  if(req.method==='GET'&&u.pathname==='/api/progress')return send(res,200,{progress:d.progress[me.email]||{}});
  if(req.method==='POST'&&u.pathname==='/api/progress'){const b=await readBody(req);d.progress[me.email]??={};d.progress[me.email][b.date]={done:!!b.done,minutes:Number(b.minutes)||120,note:b.note||''};save(d);return send(res,200,{progress:d.progress[me.email][b.date]})}
  if(req.method==='GET'&&u.pathname==='/api/notes')return send(res,200,{notes:d.notes[me.email]||[]});
  if(req.method==='POST'&&u.pathname==='/api/notes'){const b=await readBody(req);d.notes[me.email]??=[];const n={id:Date.now(),title:b.title||'未命名笔记',content:b.content||'',tags:b.tags||[],createdAt:new Date().toISOString()};d.notes[me.email].unshift(n);save(d);return send(res,200,{note:n})}
  if(req.method==='GET'&&u.pathname==='/api/forum')return send(res,200,{posts:d.posts});
  if(req.method==='POST'&&u.pathname==='/api/forum'){const b=await readBody(req);if(!b.title||!b.content)return send(res,400,{error:'标题和内容不能为空'});const p={id:Date.now(),title:b.title,content:b.content,author:me.email,likes:0,replies:[],createdAt:new Date().toISOString()};d.posts.unshift(p);save(d);return send(res,200,{post:p})}
  if(req.method==='POST'&&u.pathname.startsWith('/api/forum/')&&u.pathname.endsWith('/reply')){const idn=Number(u.pathname.split('/')[3]),b=await readBody(req),p=d.posts.find(x=>x.id===idn);if(!p)return send(res,404,{error:'帖子不存在'});p.replies.push({id:Date.now(),author:me.email,content:b.content||'',createdAt:new Date().toISOString()});save(d);return send(res,200,{post:p})}
  if(req.method==='PUT'&&u.pathname==='/api/profile'){const b=await readBody(req);d.users[me.email]={...(d.users[me.email]||{}),nickname:b.nickname||'',bio:b.bio||'',email:me.email};save(d);return send(res,200,{user:d.users[me.email]})}
  if(req.method==='GET'&&u.pathname==='/api/products')return send(res,200,{products:d.products.filter(x=>x.active!==false)});
  if(req.method==='GET'&&u.pathname==='/api/orders')return send(res,200,{orders:Object.values(d.orders).filter(x=>x.userEmail===me.email)});
  if(req.method==='POST'&&u.pathname==='/api/orders'){const b=await readBody(req),currency=String(b.currency||'').toLowerCase(),mode=b.mode==='subscription'?'subscription':'payment';if(!validCurrency(currency))return send(res,400,{error:'币种仅支持 USD/CNY'});let p;try{p=productFor(d,b.productId,currency,mode)}catch(e){return send(res,400,{error:e.message})}const order={id:id('ord'),userEmail:me.email,productId:p.id,productName:p.name,amount:p.amount,currency,mode,status:'pending',provider:'stripe',createdAt:new Date().toISOString(),paidAt:null};d.orders[order.id]=order;save(d);if(!STRIPE_SECRET_KEY)return send(res,503,{error:'Stripe 测试密钥未配置，订单已保存为 pending',order});try{const params={mode:mode==='subscription'?'subscription':'payment','success_url':APP_BASE_URL+'/success.html?orderId='+order.id,'cancel_url':APP_BASE_URL+'/cancel.html?orderId='+order.id,'client_reference_id':order.id,'metadata[orderId]':order.id,'line_items[0][price_data][currency]':currency,'line_items[0][price_data][product_data][name]':p.name,'line_items[0][price_data][unit_amount]':String(p.amount),'line_items[0][quantity]':'1'};if(mode==='subscription'){params['line_items[0][price_data][recurring][interval]']=p.interval||'month'}const session=await stripe('checkout/sessions',form(params));order.status='checkout_created';order.providerPaymentId=session.id;save(d);return send(res,200,{order,checkoutUrl:session.url})}catch(e){order.status='failed';save(d);sendEmail(me.email,'支付创建失败',paymentFailed(order),'payment_failed:'+order.id,d);return send(res,502,{error:'支付服务暂时不可用',order})}}
  if(me.role==='admin'&&req.method==='GET'&&u.pathname==='/api/admin/stats'){const records=Object.values(d.progress).reduce((n,p)=>n+Object.values(p).filter(x=>x.done).length,0);return send(res,200,{users:Object.keys(d.users).length,records,posts:d.posts.length,tasks:d.tasks.length,orders:Object.keys(d.orders).length,paidOrders:Object.values(d.orders).filter(x=>x.status==='paid').length,emailJobs:d.emailJobs.length})}
  send(res,404,{error:'Not found'});
}
http.createServer((req,res)=>app(req,res).catch(e=>{logError('request',e);send(res,500,{error:'服务器内部错误'})})).listen(PORT,()=>console.log('AI Bloom server: http://localhost:'+PORT));
