// ====== CONEXIÓN CON SUPABASE (rellena la URL de tu proyecto) ======
const SUPABASE_URL="https://hfqsnxtrawditamcpabp.supabase.co";
const SUPABASE_KEY="sb_publishable_dBLfpbeq-sFXPGTJBPkZQg_wrZUwmBW";
let db={users:[],presentations:[],rounds:[],currentRoundId:null,investments:{},movements:[],totals:{}};
let currentUser=null, token=sessionStorage.getItem("ic_token"), lastSnap="", poll=null;
async function rpc(fn,args={}){
  let r;
  try{ r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`,{method:"POST",headers:{"Content-Type":"application/json",apikey:SUPABASE_KEY},body:JSON.stringify(args)}); }
  catch{ throw new Error("Sin conexión con el servidor."); }
  const j=await r.json().catch(()=>null);
  if(!r.ok) throw new Error(j?.message||"Error del servidor.");
  return j;
}
async function act(fn,args){ try{ await rpc(fn,{p_token:token,...args}); await refresh(true); return true; }catch(e){ alert(e.message); return false; } }
async function refresh(force){
  const snap=await rpc("get_state",{p_token:token});
  const txt=JSON.stringify(snap);
  if(!force){
    if(txt===lastSnap)return;
    if(document.querySelector("#appView input:focus, #appView textarea:focus"))return; // no interrumpir mientras se escribe
  }
  lastSnap=txt; db=snap; currentUser=db.me; render();
}
function startSession(){
  show("loginView",false); show("appView",true);
  document.getElementById("sessionInfo").textContent=`Sesión: ${currentUser.name}`;
  clearInterval(poll); poll=setInterval(()=>refresh().catch(()=>{}),4000);
}
function money(value){ return new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(value); }
function escapeHtml(value){ return String(value).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
const DEFAULT_BUDGET=10000;
function getBudget(userId){ const u=db.users.find(x=>x.id===userId); return Number(u?.budget ?? DEFAULT_BUDGET); }
function getInvested(userId){ return Object.values(db.investments[userId] || {}).reduce((a,b)=>a+Number(b||0),0); }
function getAvailable(userId){ return getBudget(userId)-getInvested(userId); }
function currentRound(){ return db.rounds.find(r=>r.id===db.currentRoundId) || null; }
function ownersLabel(p){
  const names=(p.owners||[]).map(id=>db.users.find(u=>u.id===id)).filter(Boolean).map(u=>"@"+escapeHtml(u.username));
  return names.length?`<small>Autores: ${names.join(", ")}</small>`:"";
}
function presentationName(id){ return db.presentations.find(p=>p.id===id)?.name || "Presentación eliminada"; }
function show(id, visible){ document.getElementById(id).classList.toggle("hidden",!visible); }

document.getElementById("loginForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const username=document.getElementById("username").value.trim().toLowerCase();
  const password=document.getElementById("password").value;
  try{
    const r=await rpc("login",{p_username:username,p_password:password});
    token=r.token; sessionStorage.setItem("ic_token",token);
    await refresh(true); document.getElementById("loginError").textContent=""; startSession();
  }catch(err){ document.getElementById("loginError").textContent=err.message; }
});
document.getElementById("logoutBtn").addEventListener("click",()=>{
  currentUser=null; token=null; sessionStorage.removeItem("ic_token"); clearInterval(poll); show("appView",false); show("loginView",true); document.getElementById("sessionInfo").textContent="";
  document.getElementById("loginForm").reset();
});

function render(){
  if(!currentUser)return;
  const teacher=currentUser.role==="teacher";
  show("studentPanel",!teacher); show("teacherPanel",teacher);
  document.getElementById("roleLabel").textContent=teacher?"PANEL DEL PROFESOR":"PANEL DEL ALUMNO";
  document.getElementById("welcomeTitle").textContent=teacher?"Panel de control":`Hola, ${currentUser.name}`;
  document.getElementById("welcomeText").textContent=teacher?"Administra rondas, presentaciones y consulta las inversiones.":"Gestiona tu presupuesto y tus inversiones de forma anónima.";
  teacher?renderTeacher():renderStudent();
}

function renderStudent(){
  const invested=getInvested(currentUser.id), round=currentRound();
  document.getElementById("studentBudget").textContent=money(getBudget(currentUser.id));
  document.getElementById("studentInvested").textContent=money(invested);
  document.getElementById("studentAvailable").textContent=money(getAvailable(currentUser.id));
  document.getElementById("studentRoundTitle").textContent=round?round.name:"No hay ronda seleccionada";
  const open=round?.status==="open";
  document.getElementById("studentRoundStatus").textContent=open?"Abierta":"Cerrada";
  document.getElementById("studentRoundStatus").classList.toggle("closed",!open);
  document.getElementById("studentRoundMessage").textContent=open?"Puedes ajustar cuánto tienes invertido en cada presentación. Introduce la cantidad TOTAL que quieres tener invertida; no solo el cambio.":"No hay una ronda abierta. Cuando el profesor abra una, podrás modificar tus inversiones.";
  const cards=document.getElementById("presentationCards");
  cards.innerHTML=db.presentations.map(p=>{
    const mine=Number(db.investments[currentUser.id]?.[p.id]||0), isOwner=(p.owners||[]).includes(currentUser.id);
    const anonymousTotal=Number(db.totals?.[p.id]||0);
    return `<article class="presentation-card"><h3>${escapeHtml(p.name)}</h3>${p.description?`<p class="pres-desc">${escapeHtml(p.description)}</p>`:""}<p>Las cantidades de otros alumnos son anónimas.</p><div class="amount-row"><span>Tu inversión actual</span><strong>${money(mine)}</strong></div><div class="amount-row"><span>Total de la clase</span><strong>${money(anonymousTotal)}</strong></div>${isOwner?`<div class="notice owner-note">Eres autor/a de esta presentación: no puedes invertir en ella.</div>`:open?`<form class="invest-form" data-presentation="${p.id}"><input type="number" min="0" max="10000" step="50" value="${mine}" aria-label="Nueva inversión para ${escapeHtml(p.name)}"><button class="primary" type="submit">Guardar</button></form>`:""}</article>`;
  }).join("") || `<div class="notice">Todavía no hay presentaciones.</div>`;
  cards.querySelectorAll("form").forEach(form=>form.addEventListener("submit",e=>{
    e.preventDefault(); const pId=form.dataset.presentation, target=Number(form.querySelector("input").value);
    setInvestment(currentUser.id,pId,target);
  }));
  const rows=db.movements.filter(m=>m.userId===currentUser.id).slice().reverse();
  document.getElementById("studentHistory").innerHTML=rows.map(m=>`<tr><td>${new Date(m.date).toLocaleDateString("es-ES")}</td><td>${escapeHtml(db.rounds.find(r=>r.id===m.roundId)?.name||"—")}</td><td>${escapeHtml(presentationName(m.presentationId))}</td><td class="${m.delta>=0?"positive":"negative"}">${m.delta>=0?"+":""}${money(m.delta)}</td><td>${money(m.after)}</td></tr>`).join("") || `<tr><td colspan="5">Todavía no tienes movimientos.</td></tr>`;
}

function setInvestment(userId,presentationId,target){
  if(!Number.isFinite(target)||target<0){alert("Introduce una cantidad válida.");return;}
  act("set_investment",{p_presentation:presentationId,p_target:target});
}

const shownPasswords=new Set();
function changeBudget(u,amount){
  const newBudget=getBudget(u.id)+amount;
  if(newBudget<getInvested(u.id)){alert(`${u.name} ya tiene ${money(getInvested(u.id))} invertidos; no puedes dejar su presupuesto por debajo de esa cantidad.`);return false;}
  u.budget=newBudget;
  return true;
}

function renderTeacher(){
  const students=db.users.filter(u=>u.role==="student");
  document.getElementById("teacherStudents").textContent=students.length;
  document.getElementById("teacherPresentations").textContent=db.presentations.length;
  document.getElementById("teacherRounds").textContent=db.rounds.length;
  document.getElementById("studentList").innerHTML=students.map(u=>`<div class="list-item student-item"><div><strong>${escapeHtml(u.name)}</strong><small>@${escapeHtml(u.username)} · Presupuesto: ${money(getBudget(u.id))} · Disponible: ${money(getAvailable(u.id))}<br>Contraseña: <code>${shownPasswords.has(u.id)?escapeHtml(u.password):"••••••"}</code> <button type="button" class="link-btn" data-showpass="${u.id}">${shownPasswords.has(u.id)?"Ocultar":"Ver"}</button></small></div><div class="item-actions"><form class="money-form" data-addmoney="${u.id}"><input type="number" step="50" required placeholder="€" aria-label="Dinero a añadir a ${escapeHtml(u.name)}"><button class="primary" type="submit">Añadir €</button></form><button class="secondary" data-delstudent="${u.id}">Eliminar</button></div></div>`).join("") || `<div class="muted">Todavía no hay alumnos.</div>`;
  document.querySelectorAll("[data-showpass]").forEach(btn=>btn.addEventListener("click",()=>{
    const id=btn.dataset.showpass;
    shownPasswords.has(id)?shownPasswords.delete(id):shownPasswords.add(id);
    render();
  }));
  document.querySelectorAll("[data-addmoney]").forEach(f=>f.addEventListener("submit",e=>{
    e.preventDefault();
    const u=db.users.find(x=>x.id===f.dataset.addmoney); if(!u)return;
    const amount=Number(f.querySelector("input").value);
    if(!Number.isFinite(amount)||amount===0)return;
    act("change_budget",{p_user:u.id,p_amount:amount});
  }));
  document.querySelectorAll("[data-delstudent]").forEach(btn=>btn.addEventListener("click",()=>{
    const u=db.users.find(x=>x.id===btn.dataset.delstudent); if(!u)return;
    if(!confirm(`¿Eliminar a ${u.name}? Se borrarán también sus inversiones y movimientos.`))return;
    act("delete_student",{p_user:u.id});
  }));
  document.getElementById("roundList").innerHTML=db.rounds.slice().reverse().map(r=>`<div class="list-item"><div><strong>${escapeHtml(r.name)}</strong><small>${r.status==="open"?"Abierta":"Cerrada"}</small></div><button class="secondary" data-round="${r.id}" data-action="${r.status==="open"?"close":"open"}">${r.status==="open"?"Cerrar ronda":"Abrir ronda"}</button></div>`).join("");
  document.querySelectorAll("[data-round]").forEach(btn=>btn.addEventListener("click",()=>{
    const r=db.rounds.find(x=>x.id===btn.dataset.round);
    act("set_round",{p_round:r.id,p_open:btn.dataset.action==="open"});
  }));
  document.getElementById("presentationList").innerHTML=db.presentations.map(p=>`<div class="list-item"><div><strong>${escapeHtml(p.name)}</strong>${p.description?`<small class="pres-desc">${escapeHtml(p.description)}</small>`:""}${ownersLabel(p)}<small>Total: ${money(students.reduce((s,u)=>s+Number(db.investments[u.id]?.[p.id]||0),0))}</small></div><button class="secondary" data-delpres="${p.id}">Eliminar</button></div>`).join("") || `<div class="muted">No hay presentaciones.</div>`;
  document.querySelectorAll("[data-delpres]").forEach(btn=>btn.addEventListener("click",()=>{
    const p=db.presentations.find(x=>x.id===btn.dataset.delpres); if(!p)return;
    if(!confirm(`¿Eliminar "${p.name}"? Se devolverá el dinero invertido a los alumnos.`))return;
    act("delete_presentation",{p_presentation:p.id});
  }));
  const ledger=students.map(u=>{
    const inv=db.investments[u.id]||{};
    const detail=db.presentations.filter(p=>Number(inv[p.id]||0)>0).map(p=>`${escapeHtml(p.name)}: ${money(Number(inv[p.id]))}`).join("<br>")||"—";
    const available=getAvailable(u.id);
    return `<tr><td>${escapeHtml(u.name)} <span class="muted">(@${escapeHtml(u.username)})</span></td><td>${money(getInvested(u.id))}</td><td class="positive">${money(available)}</td><td>${detail}</td></tr>`;
  });
  document.getElementById("teacherLedger").innerHTML=ledger.join("")||`<tr><td colspan="4">Todavía no hay alumnos.</td></tr>`;
  document.getElementById("anonymousTotals").innerHTML=db.presentations.map(p=>{
    const total=students.reduce((s,u)=>s+Number(db.investments[u.id]?.[p.id]||0),0);
    return `<div class="total-item"><span>${escapeHtml(p.name)}</span><strong>${money(total)}</strong></div>`;
  }).join("")||`<div class="muted">No hay presentaciones.</div>`;
}

document.getElementById("studentForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=document.getElementById("studentMsg");
  const username=document.getElementById("studentUsername").value.trim().toLowerCase();
  const password=document.getElementById("studentPassword").value;
  msg.className="form-msg";
  if(!username||!password){msg.textContent="Rellena todos los campos.";msg.classList.add("error");return;}
  try{
    await rpc("create_student",{p_token:token,p_username:username,p_password:password});
    document.getElementById("studentForm").reset();
    await refresh(true);
    msg.textContent=`Alumno @${username} creado con 10.000 € de presupuesto.`;msg.classList.add("ok");
  }catch(err){msg.textContent=err.message;msg.classList.add("error");}
});
document.getElementById("allMoneyForm").addEventListener("submit",e=>{
  e.preventDefault();
  const input=document.getElementById("allMoneyAmount"), amount=Number(input.value);
  if(!Number.isFinite(amount)||amount===0)return;
  act("change_budget_all",{p_amount:amount}).then(ok=>{if(ok)input.value="";});
});
document.getElementById("roundForm").addEventListener("submit",e=>{
  e.preventDefault(); const name=document.getElementById("roundName").value.trim(); if(!name)return;
  act("create_round",{p_name:name}).then(ok=>{if(ok)document.getElementById("roundForm").reset();});
});
document.getElementById("presentationForm").addEventListener("submit",e=>{
  e.preventDefault();
  const msg=document.getElementById("presentationMsg");
  msg.className="form-msg";
  const name=document.getElementById("presentationName").value.trim(); if(!name)return;
  const handles=document.getElementById("presentationOwners").value.split(/[\s,;]+/).map(x=>x.replace(/^@/,"").toLowerCase()).filter(Boolean);
  const owners=[], missing=[];
  handles.forEach(h=>{
    const u=db.users.find(x=>x.role==="student" && x.username.toLowerCase()===h);
    if(!u){missing.push("@"+h);}else if(!owners.includes(u.id)){owners.push(u.id);}
  });
  if(missing.length){msg.textContent="No existe(n): "+missing.join(", ")+". Crea antes a esos alumnos o revisa el usuario.";msg.classList.add("error");return;}
  act("add_presentation",{p_name:name,p_desc:document.getElementById("presentationDesc").value.trim(),p_owners:owners}).then(ok=>{if(ok){document.getElementById("presentationForm").reset();msg.textContent="Presentación añadida.";msg.classList.add("ok");}});
});

// Recuperar la sesión si se recarga la página.
if(token) refresh(true).then(()=>{ if(currentUser) startSession(); }).catch(()=>{ token=null; sessionStorage.removeItem("ic_token"); });