const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { welcome, verificationCode, orderConfirmation, paymentFailed } = require('./email-templates');
const { load: loadData, save } = require('./storage');

const PORT = Number(process.env.PORT || 3200);
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:' + PORT;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const EMAIL_PROVIDER = String(process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || (SMTP_USER ? `AI Bloom <${SMTP_USER}>` : 'AI Bloom <onboarding@resend.dev>');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'test';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.CONTEXT === 'production';
const sessions = new Map();
let smtpTransport;

const units = ['Python 基础','Python 实操','大模型原理','LLM 应用','RAG 知识库','Agent 核心','框架部署','作品集项目'];
const links = ['https://liaoxuefeng.com/books/python/introduction/index.html','https://liaoxuefeng.com/books/python/introduction/index.html','https://github.com/datawhalechina/happy-llm','https://github.com/datawhalechina/hello-agents','https://github.com/datawhalechina/hello-agents','https://github.com/datawhalechina/hello-agents','https://ollama.readthedocs.io/quickstart/','https://github.com/datawhalechina/hello-agents'];

function seedTasks() { const a=[]; for(let i=0;i<56;i++){const w=Math.floor(i/7);a.push({id:i+1,day:i+1,week:w+1,module:units[w],title:i%7===6?'周测与复盘：提交本周成果':units[w]+'：理论、案例与实操',description:i%7===6?'完成可运行小作品，记录一个难点和解决方法':'理论 30 分钟 · 案例 25 分钟 · 实操 55 分钟 · 复盘 20 分钟',minutes:120,resource:links[w]})} return a; }
function load() { return loadData(seedTasks); }
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
function readBody(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(new Error('JSON 格式错误'))}});req.on('error',reject)})}
function readRaw(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>resolve(s));req.on('error',reject)})}
function auth(req){const token=(req.headers.authorization||'').replace('Bearer ','');if(sessions.has(token))return sessions.get(token);try{const [payload,signature]=token.split('.');const expected=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('hex');if(!payload||!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;return JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{return null}}
function sessionToken(user){const payload=Buffer.from(JSON.stringify(user)).toString('base64url');const signature=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('hex');return payload+'.'+signature;}
function id(prefix){return prefix+'_'+crypto.randomBytes(10).toString('hex');}
function validEmail(email){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254;}
function codeHash(email,code){return crypto.createHmac('sha256',SESSION_SECRET).update(email+':'+code).digest('hex');}
function sameHash(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function publicUser(user){if(!user)return user;const {passwordHash,...rest}=user;return {...rest,passwordSet:Boolean(passwordHash)};}
function validPassword(password){return typeof password==='string'&&password.length>=8&&password.length<=72&&/[A-Za-z]/.test(password)&&/\d/.test(password);}
function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex');return `scrypt$16384$8$1$${salt}$${hash}`;}
function verifyPassword(password,encoded){try{const [scheme,n,r,p,salt,expected]=String(encoded||'').split('$');if(scheme!=='scrypt'||!salt||!expected)return false;const actual=crypto.scryptSync(password,salt,64,{N:Number(n),r:Number(r),p:Number(p)}).toString('hex');return sameHash(actual,expected);}catch{return false;}}
function progressKey(value){const raw=String(value??'').trim();if(/^\d+$/.test(raw)){const day=Number(raw);if(day>=1&&day<=56)return String(day);}const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);if(match){const start=Date.UTC(2026,8,3),current=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]));const day=Math.floor((current-start)/86400000)+1;if(day>=1&&day<=56)return String(day);}return raw;
}
function validCurrency(x){return ['usd','cny'].includes(String(x||'').toLowerCase());}
function logError(context,error){console.error(JSON.stringify({time:new Date().toISOString(),context,error:String(error.message||error)}));}
function emailUnavailableReason(){
  if(EMAIL_PROVIDER==='smtp'&&(!SMTP_USER||!SMTP_PASS))return 'SMTP_USER 或 SMTP_PASS 未配置';
  if(EMAIL_PROVIDER==='resend'&&!RESEND_API_KEY)return 'RESEND_API_KEY 未配置';
  if(!['smtp','resend'].includes(EMAIL_PROVIDER))return 'EMAIL_PROVIDER 不受支持';
  return '';
}
async function deliverEmail(to,subject,html){
  if(EMAIL_PROVIDER==='smtp'){
    smtpTransport ??= nodemailer.createTransport({host:SMTP_HOST,port:SMTP_PORT,secure:SMTP_SECURE,auth:{user:SMTP_USER,pass:SMTP_PASS},disableFileAccess:true,disableUrlAccess:true});
    await smtpTransport.sendMail({from:EMAIL_FROM,to,subject,html});
    return;
  }
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:EMAIL_FROM,to:[to],subject,html})});
  if(!r.ok)throw new Error('Resend '+r.status+' '+await r.text());
}
async function sendEmail(to,subject,html,job,d){
  const unavailable=emailUnavailableReason();
  if(unavailable){d.emailJobs.push({job,status:'skipped',reason:unavailable,createdAt:new Date().toISOString()});await save(d);return false}
  try{await deliverEmail(to,subject,html);d.emailJobs.push({job,status:'sent',provider:EMAIL_PROVIDER,createdAt:new Date().toISOString()});await save(d);return true}
  catch(e){logError('email',e);d.emailJobs.push({job,status:'failed',provider:EMAIL_PROVIDER,error:e.message,createdAt:new Date().toISOString()});await save(d);return false}
}
function verifyStripe(raw,signature){if(!STRIPE_WEBHOOK_SECRET)return false;const parts=Object.fromEntries(String(signature||'').split(',').map(x=>x.split('=')));if(!parts.t||!parts.v1)return false;const expected=crypto.createHmac('sha256',STRIPE_WEBHOOK_SECRET).update(parts.t+'.'+raw).digest('hex');return Math.abs(expected.length-parts.v1.length)===0&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(parts.v1));}
async function stripe(pathname,body){const r=await fetch('https://api.stripe.com/v1/'+pathname,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(STRIPE_SECRET_KEY+':').toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={raw:text}}if(!r.ok)throw new Error('Stripe '+r.status+' '+text);return data;}
function form(obj){return new URLSearchParams(obj).toString();}
function productFor(d,productId,currency,mode){const p=d.products.find(x=>x.id===productId&&x.active!==false&&x.mode===mode&&x.currency===currency);if(!p||!Number.isInteger(p.amount)||p.amount<=0)throw new Error('商品未配置有效价格');return p;}
async function app(req,res){
  const u=new URL(req.url,'http://localhost'); const d=await load();
  if(req.method==='GET'&&u.pathname==='/health')return send(res,200,{ok:true,time:new Date().toISOString()});
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html'||u.pathname==='/admin')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res)}
  if(req.method==='GET'&&u.pathname==='/app.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'app.js')).pipe(res)}
  if(req.method==='GET'&&u.pathname==='/api/tasks')return send(res,200,{tasks:d.tasks});
  if(req.method==='POST'&&u.pathname==='/api/auth/request-code'){
    const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),purpose=b.purpose==='register'?'register':'login';
    if(!validEmail(email))return send(res,400,{error:'请输入有效的邮箱地址'});
    if(purpose==='register'&&d.users[email])return send(res,409,{error:'该邮箱已经注册，请直接登录'});
    if(purpose==='login'&&!d.users[email])return send(res,404,{error:'该邮箱尚未注册，请先注册'});
    const previous=d.authCodes[email],now=Date.now();
    if(previous&&now-Number(previous.sentAt)<60000)return send(res,429,{error:'验证码发送过于频繁，请稍后再试'});
    const code=String(crypto.randomInt(100000,1000000));
    d.authCodes[email]={hash:codeHash(email,code),purpose,expiresAt:now+10*60*1000,sentAt:now,attempts:0};
    const delivered=await sendEmail(email,'AI Bloom '+(purpose==='register'?'注册':'登录')+'验证码',verificationCode(code,purpose),'verification:'+purpose+':'+email,d);
    if(!delivered&&IS_PRODUCTION)return send(res,503,{error:'验证码邮件暂时无法发送，请联系网站管理员检查邮件服务配置'});
    return send(res,200,{message:'验证码已发送至 '+email,expiresIn:600,...(!IS_PRODUCTION&&!delivered?{devCode:code}:{})});
  }
  if(req.method==='POST'&&u.pathname==='/api/auth/login'){
    const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),purpose=b.purpose==='register'?'register':'login',record=d.authCodes[email];
    if(!validEmail(email)||!/^\d{6}$/.test(String(b.code||'')))return send(res,400,{error:'请输入有效的邮箱和六位验证码'});
    if(!record||record.purpose!==purpose)return send(res,401,{error:'请先获取验证码'});
    if(Date.now()>Number(record.expiresAt)){delete d.authCodes[email];await save(d);return send(res,401,{error:'验证码已过期，请重新获取'});}
    record.attempts=Number(record.attempts||0)+1;
    if(record.attempts>5){delete d.authCodes[email];await save(d);return send(res,429,{error:'验证失败次数过多，请重新获取验证码'});}
    if(!sameHash(record.hash,codeHash(email,String(b.code)))){await save(d);return send(res,401,{error:'验证码错误'});}
    delete d.authCodes[email];
    if(purpose==='register'&&d.users[email]){await save(d);return send(res,409,{error:'该邮箱已经注册，请直接登录'});}
    if(purpose==='login'&&!d.users[email]){await save(d);return send(res,404,{error:'该邮箱尚未注册，请先注册'});}
    const isNew=purpose==='register';
    if(isNew)d.users[email]={email,nickname:'',fullName:'',bio:'',country:'',city:'',timezone:'',language:'',occupation:'',organization:'',experienceLevel:'',weeklyHours:'',learningGoal:'',learningGoals:[],interests:[],learningStyle:'',preferredStudyTime:'',website:'',github:'',allowDiscovery:false,passwordHash:null,profileCompleted:false,registeredAt:new Date().toISOString()};
    await save(d);
    if(isNew)await sendEmail(email,'欢迎加入 AI Bloom',welcome(d.users[email]),'welcome:'+email,d);
    const user={email,role:'user'},token=sessionToken(user);sessions.set(token,user);
    return send(res,200,{token,user:publicUser(d.users[email]),isNew,needsProfile:!d.users[email].profileCompleted,needsPassword:!d.users[email].passwordHash});
  }
  if(req.method==='POST'&&u.pathname==='/api/auth/password-login'){
    const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),record=d.users[email];
    if(!validEmail(email)||!password)return send(res,400,{error:'请输入有效的邮箱和密码'});
    if(!record||!record.passwordHash||!verifyPassword(password,record.passwordHash))return send(res,401,{error:'邮箱或密码不正确；忘记密码可使用邮箱验证码登录后重设'});
    const user={email,role:'user'},token=sessionToken(user);sessions.set(token,user);
    return send(res,200,{token,user:publicUser(record),isNew:false,needsProfile:!record.profileCompleted,needsPassword:false});
  }
  if(req.method==='POST'&&u.pathname==='/api/admin/login'){const b=await readBody(req);if(b.email!==ADMIN_EMAIL||b.password!==ADMIN_PASSWORD)return send(res,401,{error:'管理员账号或密码错误'});const user={email:b.email,role:'admin'},token=sessionToken(user);sessions.set(token,user);return send(res,200,{token,user})}
  if(req.method==='POST'&&u.pathname==='/api/payments/stripe/webhook'){const raw=await readRaw(req);if(!verifyStripe(raw,req.headers['stripe-signature']))return send(res,400,{error:'webhook 签名无效'});const event=JSON.parse(raw);if(d.paymentEvents[event.id])return send(res,200,{received:true,duplicate:true});d.paymentEvents[event.id]={type:event.type,receivedAt:new Date().toISOString()};const obj=event.data?.object||{};const order=d.orders[obj.metadata?.orderId||obj.client_reference_id];if(order&&(event.type==='checkout.session.completed'||event.type==='invoice.paid')){if(order.status!=='paid'){order.status='paid';order.paidAt=new Date().toISOString();await sendEmail(order.userEmail,'订单支付成功',orderConfirmation(order),'order_confirmation:'+order.id,d)}}else if(order&&(event.type==='checkout.session.async_payment_failed'||event.type==='invoice.payment_failed')){order.status='failed';await sendEmail(order.userEmail,'支付失败通知',paymentFailed(order),'payment_failed:'+order.id,d)}await save(d);return send(res,200,{received:true})}
  const me=auth(req); if(!me)return send(res,401,{error:'请先登录'});
  if(req.method==='POST'&&u.pathname==='/api/auth/password'){
    const b=await readBody(req),password=String(b.password||''),confirm=String(b.confirmPassword||password);
    if(!validPassword(password))return send(res,400,{error:'密码需为 8-72 位，并同时包含字母和数字'});
    if(password!==confirm)return send(res,400,{error:'两次输入的密码不一致'});
    const current=d.users[me.email]||{email:me.email,registeredAt:new Date().toISOString()};
    d.users[me.email]={...current,passwordHash:hashPassword(password),passwordSetAt:new Date().toISOString()};
    await save(d);return send(res,200,{user:publicUser(d.users[me.email])});
  }
  if(req.method==='GET'&&u.pathname==='/api/me')return send(res,200,{user:publicUser(d.users[me.email]||me)});
  if(req.method==='GET'&&u.pathname==='/api/progress')return send(res,200,{progress:d.progress[me.email]||{}});
  if(req.method==='POST'&&u.pathname==='/api/progress'){const b=await readBody(req),day=progressKey(b.day??b.taskId??b.date);if(!/^([1-9]|[1-5][0-9]|56)$/.test(day))return send(res,400,{error:'打卡日必须是第 1-56 天'});d.progress[me.email]??={};d.progress[me.email][day]={day:Number(day),done:!!b.done,minutes:Number(b.minutes)||120,note:b.note||''};await save(d);return send(res,200,{progress:d.progress[me.email][day]})}
  if(req.method==='GET'&&u.pathname==='/api/notes')return send(res,200,{notes:d.notes[me.email]||[]});
  if(req.method==='POST'&&u.pathname==='/api/notes'){const b=await readBody(req);d.notes[me.email]??=[];const n={id:Date.now(),title:b.title||'未命名笔记',content:b.content||'',tags:b.tags||[],createdAt:new Date().toISOString()};d.notes[me.email].unshift(n);await save(d);return send(res,200,{note:n})}
  if(req.method==='GET'&&u.pathname==='/api/forum')return send(res,200,{posts:d.posts});
  if(req.method==='POST'&&u.pathname==='/api/forum'){const b=await readBody(req);if(!b.title||!b.content)return send(res,400,{error:'标题和内容不能为空'});const p={id:Date.now(),title:b.title,content:b.content,author:me.email,likes:0,replies:[],createdAt:new Date().toISOString()};d.posts.unshift(p);await save(d);return send(res,200,{post:p})}
  if(req.method==='POST'&&u.pathname.startsWith('/api/forum/')&&u.pathname.endsWith('/reply')){const idn=Number(u.pathname.split('/')[3]),b=await readBody(req),p=d.posts.find(x=>x.id===idn);if(!p)return send(res,404,{error:'帖子不存在'});p.replies.push({id:Date.now(),author:me.email,content:b.content||'',createdAt:new Date().toISOString()});await save(d);return send(res,200,{post:p})}
  if(req.method==='PUT'&&u.pathname==='/api/profile'){
    const b=await readBody(req),nickname=String(b.nickname||'').trim(),country=String(b.country||'').trim(),rawGoals=Array.isArray(b.learningGoals)?b.learningGoals:(Array.isArray(b.learningGoal)?b.learningGoal:[b.learningGoal]),goals=rawGoals.map(x=>String(x||'').trim()).filter(Boolean).slice(0,6),goal=goals.join('、'),level=String(b.experienceLevel||'').trim();
    if(!nickname||!country||!goal||!level)return send(res,400,{error:'昵称、国家或地区、经验水平和学习目标为必填项'});
    const current=d.users[me.email]||{email:me.email,registeredAt:new Date().toISOString()};
    d.users[me.email]={...current,email:me.email,nickname:nickname.slice(0,40),country:country.slice(0,60),experienceLevel:level.slice(0,40),learningGoals:goals,learningGoal:goal.slice(0,300),interests:Array.isArray(b.interests)?b.interests.map(x=>String(x).trim()).filter(Boolean).slice(0,12):[],weeklyHours:String(b.weeklyHours||'').trim().slice(0,30),learningStyle:String(b.learningStyle||'').trim().slice(0,40),preferredStudyTime:String(b.preferredStudyTime||'').trim().slice(0,30),timezone:String(b.timezone||'').trim().slice(0,60),language:String(b.language||'').trim().slice(0,30),allowDiscovery:!!b.allowDiscovery,profileCompleted:true,updatedAt:new Date().toISOString()};
    await save(d);return send(res,200,{user:publicUser(d.users[me.email])});
  }
  if(req.method==='GET'&&u.pathname==='/api/products')return send(res,200,{products:d.products.filter(x=>x.active!==false)});
  if(req.method==='GET'&&u.pathname==='/api/orders')return send(res,200,{orders:Object.values(d.orders).filter(x=>x.userEmail===me.email)});
  if(req.method==='POST'&&u.pathname==='/api/orders'){const b=await readBody(req),currency=String(b.currency||'').toLowerCase(),mode=b.mode==='subscription'?'subscription':'payment';if(!validCurrency(currency))return send(res,400,{error:'币种仅支持 USD/CNY'});let p;try{p=productFor(d,b.productId,currency,mode)}catch(e){return send(res,400,{error:e.message})}const order={id:id('ord'),userEmail:me.email,productId:p.id,productName:p.name,amount:p.amount,currency,mode,status:'pending',provider:'stripe',createdAt:new Date().toISOString(),paidAt:null};d.orders[order.id]=order;await save(d);if(!STRIPE_SECRET_KEY)return send(res,503,{error:'Stripe 测试密钥未配置，订单已保存为 pending',order});try{const params={mode:mode==='subscription'?'subscription':'payment','success_url':APP_BASE_URL+'/success.html?orderId='+order.id,'cancel_url':APP_BASE_URL+'/cancel.html?orderId='+order.id,'client_reference_id':order.id,'metadata[orderId]':order.id,'line_items[0][price_data][currency]':currency,'line_items[0][price_data][product_data][name]':p.name,'line_items[0][price_data][unit_amount]':String(p.amount),'line_items[0][quantity]':'1'};if(mode==='subscription'){params['line_items[0][price_data][recurring][interval]']=p.interval||'month'}const session=await stripe('checkout/sessions',form(params));order.status='checkout_created';order.providerPaymentId=session.id;await save(d);return send(res,200,{order,checkoutUrl:session.url})}catch(e){order.status='failed';await save(d);await sendEmail(me.email,'支付创建失败',paymentFailed(order),'payment_failed:'+order.id,d);return send(res,502,{error:'支付服务暂时不可用',order})}}
  if(me.role==='admin'&&req.method==='GET'&&u.pathname==='/api/admin/stats'){const records=Object.values(d.progress).reduce((n,p)=>n+Object.values(p).filter(x=>x.done).length,0);return send(res,200,{users:Object.keys(d.users).length,records,posts:d.posts.length,tasks:d.tasks.length,orders:Object.keys(d.orders).length,paidOrders:Object.values(d.orders).filter(x=>x.status==='paid').length,emailJobs:d.emailJobs.length})}
  send(res,404,{error:'Not found'});
}
module.exports = { app };
if (require.main === module) {
  http.createServer((req,res)=>app(req,res).catch(e=>{logError('request',e);send(res,500,{error:'服务器内部错误'})})).listen(PORT,()=>console.log('AI Bloom server: http://localhost:'+PORT));
}
