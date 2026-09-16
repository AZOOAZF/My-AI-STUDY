const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { welcome, verificationCode, orderConfirmation, paymentFailed } = require('./email-templates');
const { load: loadData, save } = require('./storage');

const PORT = Number(process.env.PORT || 3200);
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:' + PORT;
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.CONTEXT === 'production' || process.env.VERCEL_ENV === 'production';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const EMAIL_PROVIDER = String(process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_CONNECTION_TIMEOUT = Number(process.env.SMTP_CONNECTION_TIMEOUT || 5000);
const SMTP_GREETING_TIMEOUT = Number(process.env.SMTP_GREETING_TIMEOUT || 5000);
const SMTP_SOCKET_TIMEOUT = Number(process.env.SMTP_SOCKET_TIMEOUT || 10000);
const EMAIL_FROM = process.env.EMAIL_FROM || (SMTP_USER ? `AI Bloom <${SMTP_USER}>` : 'AI Bloom <onboarding@resend.dev>');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'test';
const SESSION_SECRET = process.env.SESSION_SECRET || (!IS_PRODUCTION ? crypto.randomBytes(32).toString('hex') : '');
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const JSON_BODY_LIMIT = 64 * 1024;
const WEBHOOK_BODY_LIMIT = 1024 * 1024;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const authAttempts = new Map();
let smtpTransport;

const units = ['Python 基础','Python 实操','大模型原理','LLM 应用','RAG 知识库','Agent 核心','框架部署','作品集项目'];
const links = ['https://liaoxuefeng.com/books/python/introduction/index.html','https://liaoxuefeng.com/books/python/introduction/index.html','https://github.com/datawhalechina/happy-llm','https://github.com/datawhalechina/hello-agents','https://github.com/datawhalechina/hello-agents','https://github.com/datawhalechina/hello-agents','https://ollama.readthedocs.io/quickstart/','https://github.com/datawhalechina/hello-agents'];

function seedTasks() { const a=[]; for(let i=0;i<56;i++){const w=Math.floor(i/7);a.push({id:i+1,day:i+1,week:w+1,module:units[w],title:i%7===6?'周测与复盘：提交本周成果':units[w]+'：理论、案例与实操',description:i%7===6?'完成可运行小作品，记录一个难点和解决方法':'理论 30 分钟 · 案例 25 分钟 · 实操 55 分钟 · 复盘 20 分钟',minutes:120,resource:links[w]})} return a; }
function load() { return loadData(seedTasks); }
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));}
function readLimited(req,limit,parser){return new Promise((resolve,reject)=>{const length=Number(req.headers['content-length']);if(Number.isFinite(length)&&length>limit){req.resume();const error=new Error('请求体过大');error.statusCode=413;reject(error);return}let chunks=[],size=0,settled=false;req.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>limit){settled=true;req.resume();const error=new Error('请求体过大');error.statusCode=413;reject(error);return}chunks.push(chunk)});req.on('end',()=>{if(settled)return;const raw=Buffer.concat(chunks).toString('utf8');try{resolve(parser(raw))}catch(error){reject(error)}});req.on('error',error=>{if(!settled){settled=true;reject(error)}})})}
function readBody(req){return readLimited(req,JSON_BODY_LIMIT,raw=>{try{return raw?JSON.parse(raw):{}}catch{throw new Error('JSON 格式错误')}})}
function readRaw(req){return readLimited(req,WEBHOOK_BODY_LIMIT,raw=>raw)}
function auth(req){if(!SESSION_SECRET)return null;const header=String(req.headers.authorization||'');if(!header.startsWith('Bearer '))return null;const token=header.slice(7);try{const [payload,signature]=token.split('.');const expected=crypto.createHmac('sha256',SESSION_SECRET).update(payload||'').digest('hex');if(!payload||!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;const user=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(!user||typeof user.email!=='string'||typeof user.role!=='string'||!Number.isFinite(user.exp)||Date.now()>user.exp)return null;return user;}catch{return null}}
function sessionToken(user){const now=Date.now();const payload=Buffer.from(JSON.stringify({...user,iat:now,exp:now+ACCESS_TTL_MS})).toString('base64url');const signature=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('hex');return payload+'.'+signature;}
function refreshTokenHash(token){return crypto.createHmac('sha256',SESSION_SECRET).update(String(token||'')).digest('hex');}
function issueRefreshToken(email,role,d){const token=crypto.randomBytes(32).toString('base64url');d.refreshTokens[refreshTokenHash(token)]={email,role,expiresAt:Date.now()+REFRESH_TTL_MS,createdAt:new Date().toISOString()};return token;}
function consumeRefreshToken(token,d){const key=refreshTokenHash(token),record=d.refreshTokens[key];if(!record||Date.now()>Number(record.expiresAt)){delete d.refreshTokens[key];return null;}delete d.refreshTokens[key];return {email:record.email,role:record.role};}
function id(prefix){return prefix+'_'+crypto.randomBytes(10).toString('hex');}
function validEmail(email){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254;}
function codeHash(email,code){return crypto.createHmac('sha256',SESSION_SECRET).update(email+':'+code).digest('hex');}
function challengeToken(email,purpose,hash,expiresAt){const payload=Buffer.from(JSON.stringify({email,purpose,hash,expiresAt})).toString('base64url');return payload+'.'+crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('hex');}
function challengeData(token){try{const [payload,signature]=String(token||'').split('.');const expected=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('hex');if(!payload||!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return Date.now()<=Number(data.expiresAt)?data:null;}catch{return null;}}
function sameHash(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function publicUser(user){if(!user)return user;const {passwordHash,...rest}=user;return {...rest,passwordSet:Boolean(passwordHash)};}
function validPassword(password){return typeof password==='string'&&password.length>=8&&password.length<=72&&/[A-Za-z]/.test(password)&&/\d/.test(password);}
function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex');return `scrypt$16384$8$1$${salt}$${hash}`;}
function verifyPassword(password,encoded){try{const [scheme,n,r,p,salt,expected]=String(encoded||'').split('$');if(scheme!=='scrypt'||!salt||!expected)return false;const actual=crypto.scryptSync(password,salt,64,{N:Number(n),r:Number(r),p:Number(p)}).toString('hex');return sameHash(actual,expected);}catch{return false;}}
function progressKey(value){const raw=String(value??'').trim();if(/^\d+$/.test(raw)){const day=Number(raw);if(day>=1&&day<=56)return String(day);}const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);if(match){const start=Date.UTC(2026,8,3),current=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]));const day=Math.floor((current-start)/86400000)+1;if(day>=1&&day<=56)return String(day);}return raw;
}
function validCurrency(x){return ['usd','cny'].includes(String(x||'').toLowerCase());}
function quizAnswer(value){return String(value||'').trim().toLowerCase().replace(/\s+/g,'');}
function logError(context,error){console.error(JSON.stringify({time:new Date().toISOString(),context,error:String(error.message||error)}));}
function emailUnavailableReason(){
  if(EMAIL_PROVIDER==='smtp'&&(!SMTP_USER||!SMTP_PASS))return 'SMTP_USER 或 SMTP_PASS 未配置';
  if(EMAIL_PROVIDER==='resend'&&!RESEND_API_KEY)return 'RESEND_API_KEY 未配置';
  if(!['smtp','resend'].includes(EMAIL_PROVIDER))return 'EMAIL_PROVIDER 不受支持';
  return '';
}
function authUnavailableReason(){
  if(!SESSION_SECRET)return 'SESSION_SECRET 未配置';
  return '';
}
function safeEqualString(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;return crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function authAttemptKey(req,scope,email){const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();return scope+':'+(forwarded||req.socket?.remoteAddress||'unknown')+':'+email;}
function allowAuthAttempt(key){const now=Date.now(),current=authAttempts.get(key);if(!current||now>=current.resetAt){authAttempts.set(key,{count:1,resetAt:now+AUTH_WINDOW_MS});return true;}current.count+=1;return current.count<=AUTH_MAX_ATTEMPTS;}
function clearAuthAttempts(key){authAttempts.delete(key);}
async function deliverEmail(to,subject,html){
  if(EMAIL_PROVIDER==='smtp'){
    smtpTransport ??= nodemailer.createTransport({host:SMTP_HOST,port:SMTP_PORT,secure:SMTP_SECURE,auth:{user:SMTP_USER,pass:SMTP_PASS},connectionTimeout:SMTP_CONNECTION_TIMEOUT,greetingTimeout:SMTP_GREETING_TIMEOUT,socketTimeout:SMTP_SOCKET_TIMEOUT,disableFileAccess:true,disableUrlAccess:true});
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
    const authUnavailable=authUnavailableReason();if(authUnavailable&&IS_PRODUCTION)return send(res,503,{error:'认证服务暂时不可用，请联系网站管理员'});
    const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),purpose=b.purpose==='register'?'register':'login';
    if(!validEmail(email))return send(res,400,{error:'请输入有效的邮箱地址'});
    if(purpose==='register'&&d.users[email])return send(res,409,{error:'该邮箱已经注册，请直接登录'});
    if(purpose==='login'&&!d.users[email])return send(res,404,{error:'该邮箱尚未注册，请先注册'});
    const previous=d.authCodes[email],now=Date.now();
    if(previous&&now-Number(previous.sentAt)<60000)return send(res,429,{error:'验证码发送过于频繁，请稍后再试'});
    const code=String(crypto.randomInt(100000,1000000));
    d.authCodes[email]={hash:codeHash(email,code),purpose,expiresAt:now+10*60*1000,sentAt:now,attempts:0};
    const challenge=challengeToken(email,purpose,d.authCodes[email].hash,d.authCodes[email].expiresAt);
    const delivered=await sendEmail(email,'AI Bloom '+(purpose==='register'?'注册':'登录')+'验证码',verificationCode(code,purpose),'verification:'+purpose+':'+email,d);
    if(!delivered&&IS_PRODUCTION)return send(res,503,{error:'验证码邮件暂时无法发送，请联系网站管理员检查邮件服务配置'});
    return send(res,200,{message:'验证码已发送至 '+email,expiresIn:600,challenge,...(!IS_PRODUCTION&&!delivered?{devCode:code}:{})});
  }
  if(req.method==='POST'&&u.pathname==='/api/auth/login'){
    const authUnavailable=authUnavailableReason();if(authUnavailable&&IS_PRODUCTION)return send(res,503,{error:'认证服务暂时不可用，请联系网站管理员'});
    const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),purpose=b.purpose==='register'?'register':'login',challenge=challengeData(b.challenge),record=challenge&&challenge.email===email&&challenge.purpose===purpose?challenge:d.authCodes[email];
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
    const user={email,role:'user'},token=sessionToken(user),refreshToken=issueRefreshToken(email,'user',d);
    await save(d);
    if(isNew)await sendEmail(email,'欢迎加入 AI Bloom',welcome(d.users[email]),'welcome:'+email,d);
    return send(res,200,{token,refreshToken,user:publicUser(d.users[email]),isNew,needsProfile:!d.users[email].profileCompleted,needsPassword:!d.users[email].passwordHash});
  }
  if(req.method==='POST'&&u.pathname==='/api/auth/password-login'){
    const authUnavailable=authUnavailableReason();if(authUnavailable&&IS_PRODUCTION)return send(res,503,{error:'认证服务暂时不可用，请联系网站管理员'});
    const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),record=d.users[email],attemptKey=authAttemptKey(req,'password',email);if(!allowAuthAttempt(attemptKey))return send(res,429,{error:'登录尝试过于频繁，请 15 分钟后再试'});
    if(!validEmail(email)||!password)return send(res,400,{error:'请输入有效的邮箱和密码'});
    if(!record||!record.passwordHash||!verifyPassword(password,record.passwordHash))return send(res,401,{error:'邮箱或密码不正确；忘记密码可使用邮箱验证码登录后重设'});
    clearAuthAttempts(attemptKey);const user={email,role:'user'},token=sessionToken(user),refreshToken=issueRefreshToken(email,'user',d);await save(d);
    return send(res,200,{token,refreshToken,user:publicUser(record),isNew:false,needsProfile:!record.profileCompleted,needsPassword:false});
  }
  if(req.method==='POST'&&u.pathname==='/api/admin/login'){const b=await readBody(req);if(!ADMIN_EMAIL||!ADMIN_PASSWORD||!SESSION_SECRET)return send(res,503,{error:'管理员认证尚未配置'});const email=String(b.email||'').trim().toLowerCase(),attemptKey=authAttemptKey(req,'admin',email);if(!allowAuthAttempt(attemptKey))return send(res,429,{error:'登录尝试过于频繁，请 15 分钟后再试'});if(!safeEqualString(email,ADMIN_EMAIL)||!safeEqualString(String(b.password||''),ADMIN_PASSWORD))return send(res,401,{error:'管理员账号或密码错误'});clearAuthAttempts(attemptKey);const user={email,role:'admin'},token=sessionToken(user),refreshToken=issueRefreshToken(email,'admin',d);await save(d);return send(res,200,{token,refreshToken,user})}
  if(req.method==='POST'&&u.pathname==='/api/auth/refresh'){
    if(!SESSION_SECRET)return send(res,503,{error:'认证服务暂时不可用，请联系网站管理员'});
    const b=await readBody(req),record=consumeRefreshToken(b.refreshToken,d);if(!record)return send(res,401,{error:'登录状态已失效，请重新登录'});
    const token=sessionToken(record.user||record),refreshToken=issueRefreshToken(record.email,record.role,d);await save(d);
    return send(res,200,{token,refreshToken,user:record.role==='admin'?record:publicUser(d.users[record.email]||record)});
  }
  if(req.method==='POST'&&u.pathname==='/api/auth/logout'){
    const b=await readBody(req);if(b.refreshToken){delete d.refreshTokens[refreshTokenHash(b.refreshToken)];await save(d);}return send(res,200,{ok:true});
  }
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
  if(req.method==='GET'&&u.pathname==='/api/me')return send(res,200,{user:me.role==='admin'?me:publicUser(d.users[me.email]||me)});
  if(req.method==='GET'&&u.pathname==='/api/progress')return send(res,200,{progress:d.progress[me.email]||{}});
  if(req.method==='GET'&&u.pathname==='/api/quiz-results')return send(res,200,{results:d.quizResults[me.email]||{}});
  if(req.method==='POST'&&u.pathname==='/api/quiz-results'){
    const b=await readBody(req),kind=b.kind==='weekly'?'weekly':'daily',period=Number(kind==='weekly'?b.week:b.day),paper=Array.isArray(b.answers)?b.answers:[],total=kind==='weekly'?21:100,typeTotals=kind==='weekly'?{fill:7,choice:7,response:7}:{fill:34,choice:33,response:33};
    if(!Number.isInteger(period)||(kind==='weekly'?(period<1||period>8):(period<1||period>56))||paper.length!==total)return send(res,400,{error:kind==='weekly'?'周练习必须提交完整的 21 道题':'试卷必须提交完整的 100 道题'});
    const seen=new Set(),counts={fill:0,choice:0,response:0},scores={fill:0,choice:0,response:0};let correct=0;for(const item of paper){const type=String(item.type||''),id=String(item.id||''),sourceDay=Number(item.sourceDay),task=d.tasks.find(taskItem=>taskItem.day===sourceDay),value=String(item.value||'').trim(),prefix=kind==='weekly'?'weekly-': '',validId=(kind==='weekly'?/^weekly-(fill|choice|response)-\d+$/.test(id):/^((fill|choice|response)-\d+)$/.test(id))&&id.startsWith(prefix+type+'-');if(!task||!validId||seen.has(id)||!Object.prototype.hasOwnProperty.call(counts,type)||(kind==='weekly'&&task.week!==period))return send(res,400,{error:'试卷题目数据无效'});seen.add(id);counts[type]++;let isCorrect=false;if(type==='fill'||type==='choice')isCorrect=quizAnswer(value)===quizAnswer(task.answer);else isCorrect=Boolean(value);if(isCorrect){correct++;scores[type]++;}}
    if(counts.fill!==typeTotals.fill||counts.choice!==typeTotals.choice||counts.response!==typeTotals.response)return send(res,400,{error:kind==='weekly'?'周练习题型数量必须为 7/7/7':'试卷题型数量必须为 34/33/33'});
    const key=kind==='weekly'?'w'+period:String(period);d.quizResults[me.email]??={};d.quizResults[me.email][key]={kind,week:kind==='weekly'?period:undefined,day:kind==='daily'?period:undefined,score:correct,total,correct,counts,typeTotals,scores,submittedAt:new Date().toISOString()};await save(d);return send(res,200,{result:d.quizResults[me.email][key]});
  }
  if(req.method==='POST'&&u.pathname==='/api/progress'){const b=await readBody(req),day=progressKey(b.day??b.taskId??b.date),minutes=Number(b.minutes);if(!/^([1-9]|[1-5][0-9]|56)$/.test(day))return send(res,400,{error:'打卡日必须是第 1-56 天'});if(!Number.isFinite(minutes)||minutes<0||minutes>1440)return send(res,400,{error:'学习时长必须是 0-1440 分钟'});if(String(b.note||'').length>2000)return send(res,400,{error:'复盘内容不能超过 2000 个字符'});d.progress[me.email]??={};d.progress[me.email][day]={day:Number(day),done:!!b.done,minutes,note:String(b.note||'')};await save(d);return send(res,200,{progress:d.progress[me.email][day]})}
  if(req.method==='GET'&&u.pathname==='/api/notes')return send(res,200,{notes:d.notes[me.email]||[]});
  if(req.method==='POST'&&u.pathname==='/api/notes'){const b=await readBody(req),title=String(b.title||'未命名笔记').trim(),content=String(b.content||'');if(title.length>200||content.length>10000)return send(res,400,{error:'笔记标题最多 200 个字符，内容最多 10000 个字符'});d.notes[me.email]??=[];const n={id:Date.now(),title,content,tags:Array.isArray(b.tags)?b.tags.slice(0,12).map(x=>String(x).slice(0,40)):[],createdAt:new Date().toISOString()};d.notes[me.email].unshift(n);await save(d);return send(res,200,{note:n})}
  if(req.method==='GET'&&u.pathname==='/api/forum')return send(res,200,{posts:d.posts});
  if(req.method==='POST'&&u.pathname==='/api/forum'){const b=await readBody(req),title=String(b.title||'').trim(),content=String(b.content||'');if(!title||!content)return send(res,400,{error:'标题和内容不能为空'});if(title.length>200||content.length>10000)return send(res,400,{error:'标题最多 200 个字符，内容最多 10000 个字符'});const p={id:Date.now(),title,content,author:me.email,likes:0,replies:[],createdAt:new Date().toISOString()};d.posts.unshift(p);await save(d);return send(res,200,{post:p})}
  if(req.method==='POST'&&u.pathname.startsWith('/api/forum/')&&u.pathname.endsWith('/reply')){const idn=Number(u.pathname.split('/')[3]),b=await readBody(req),content=String(b.content||'').trim(),p=d.posts.find(x=>x.id===idn);if(!p)return send(res,404,{error:'帖子不存在'});if(!content)return send(res,400,{error:'回复内容不能为空'});if(content.length>5000)return send(res,400,{error:'回复内容不能超过 5000 个字符'});p.replies.push({id:Date.now(),author:me.email,content,createdAt:new Date().toISOString()});await save(d);return send(res,200,{post:p})}
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
  http.createServer((req,res)=>app(req,res).catch(e=>{logError('request',e);send(res,e.statusCode||500,{error:e.statusCode===413?'请求体过大':'服务器内部错误'})})).listen(PORT,()=>console.log('AI Bloom server: http://localhost:'+PORT));
}
