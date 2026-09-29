export function html(needsToken: boolean, embed = false): string {
  return /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JIT Inventory Sourcer · thesqua.re</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#626a78;--line:#e3e6eb;--acc:#1f5eff;--ok:#0f8a4f;--warn:#b25e00;--bad:#c62828}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{padding:16px 20px;background:#101522;color:#fff;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
header h1{font-size:17px;margin:0}header span{color:#aab3c5;font-size:13px}
main{max-width:1320px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
form{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px 12px;align-items:end}
label{display:flex;flex-direction:column;font-size:12px;color:var(--mute);gap:4px}
input,select{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink)}
.wide{grid-column:span 2}
button{font:inherit;padding:8px 14px;border-radius:7px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer}
button.sec{background:#fff;color:var(--acc)}button:disabled{opacity:.5;cursor:wait}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.kpi{border:1px solid var(--line);border-radius:8px;padding:10px}.kpi b{display:block;font-size:19px}.kpi small{color:var(--mute)}
h2{font-size:15px;margin:0 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}h2 .sp{flex:1}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600;white-space:nowrap;background:#fafbfc;position:sticky;top:0}
td.n{text-align:right;white-space:nowrap}.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;background:#eef2ff;color:#2c3e91;margin:1px 2px 1px 0}
.pill.w{background:#fff4e5;color:var(--warn)}.pill.ok{background:#e7f6ee;color:var(--ok)}
.score{font-weight:700}.muted{color:var(--mute)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.links a{display:inline-block;margin:0 8px 6px 0;padding:6px 10px;border:1px solid var(--line);border-radius:7px;text-decoration:none;color:var(--acc);background:#fff}
ul.notes{margin:6px 0 0;padding-left:18px}ul.notes li{margin:3px 0}
#status{font-size:12px}
nav.tabs{display:flex;gap:4px;margin:0 0 12px}nav.tabs button{background:#fff;color:var(--ink);border:1px solid var(--line)}nav.tabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.thumb{width:96px;height:64px;object-fit:cover;border-radius:6px;cursor:zoom-in;background:#eef0f3;display:block}
.nothumb{width:96px;height:64px;border-radius:6px;background:#eef0f3;display:flex;align-items:center;justify-content:center;color:var(--mute);font-size:11px}
#gal{position:fixed;inset:0;background:rgba(10,12,18,.92);display:none;align-items:center;justify-content:center;z-index:50;flex-direction:column;gap:10px}
#gal img{max-width:92vw;max-height:78vh;border-radius:8px}#gal .bar{color:#fff;display:flex;gap:10px;align-items:center}
#gal button{background:#fff;color:#111;border:none}.strip{display:flex;gap:6px;overflow-x:auto;max-width:92vw}.strip img{width:72px;height:48px;object-fit:cover;border-radius:4px;cursor:pointer;opacity:.6}.strip img.on{opacity:1;outline:2px solid #fff}
.pill.a{background:#e7f6ee;color:var(--ok)}.pill.q{background:#f1f3f6;color:var(--mute)}
tr.clk{cursor:pointer}tr.clk:hover td{background:#f7f9ff}
@media print{header,form,.noprint{display:none!important}.card{border:none;padding:0}}
</style></head><body>
${embed ? "<style>header{display:none}main{padding:8px}</style>" : ""}<header><h1>Just-in-time Inventory Sourcer</h1><span>Find lettable stock when we have an enquiry but no inventory</span></header>
<main>
<nav class="tabs noprint"><button class="on" data-tab="search">Search</button><button data-tab="history">Saved searches</button><button data-tab="bulk">Bulk upload</button></nav>
<section id="tab-search">
<div class="card noprint">
<form id="f">
  <label class="wide">Location (postcode, area or city)<input name="location" required placeholder="e.g. Canary Wharf, E14, Manchester"></label>
  <label>Check-in<input type="date" name="checkIn" required></label>
  <label>Check-out<input type="date" name="checkOut" required></label>
  <label>Bedrooms<select name="bedrooms">
    <option value="0">Studio</option><option value="1">1 bed</option><option value="2" selected>2 bed</option><option value="3">3 bed</option>
    <option value="4">4 bed</option><option value="5">5 bed</option><option value="6">6 bed</option></select></label>
  <label>Min bathrooms<input type="number" name="bathrooms" min="1" max="6" placeholder="any"></label>
  <label>Beds needed<input type="number" name="beds" min="1" max="12" placeholder="e.g. 3"></label>
  <label>Furnished<select name="furnished"><option value="any">Any</option><option value="furnished" selected>Furnished</option><option value="unfurnished">Unfurnished</option></select></label>
  <label>Accessibility<select name="accessibility"><option value="any">Any</option><option value="ground_floor">Ground floor</option><option value="step_free">Step-free (ground floor or lift)</option><option value="wheelchair">Wheelchair accessible</option></select></label>
  <label>Max rent (£ pcm)<input type="number" name="maxRentPcm" min="0" step="50" placeholder="optional"></label>
  <label>Radius (miles)<input type="number" name="radiusMiles" min="1" max="40" value="3"></label>
  <label>Our sell rate (£/night)<input type="number" name="sellRateNightly" min="0" placeholder="for margin"></label>
  <label>Setup cost (£)<input type="number" name="setupCost" min="0" placeholder="furnish/onboard"></label>
  <label>Client account<input name="clientAccount" placeholder="optional"></label>
  <label>Enquiry ref<input name="enquiryRef" placeholder="optional"></label>
  ${needsToken ? '<label>Access token (asked once per device)<input name="token" type="password" autocomplete="off"></label>' : ""}
  <button id="go">Search</button>
</form>
<div id="status" class="muted" style="margin-top:8px"></div>
</div>
<div id="out"></div>
</section>
<section id="tab-history" hidden><div class="card"><h2>Saved searches<span class="sp"></span><input id="hq" placeholder="Filter: location, postcode, ref, client" style="min-width:260px"><button class="sec" onclick="loadHistory()">Refresh</button></h2><div id="hist" class="muted">Loading…</div></div></section>
<section id="tab-bulk" hidden>
  <div class="card"><h2>Bulk upload</h2>
    <p class="muted" style="margin-top:0">Upload a CSV or Excel sheet with one enquiry per row. Rows are searched in the background (about 2 per minute) and every result is saved — you can close this page.
    Columns: <code>location, check_in, check_out, bedrooms</code> (required) and optional <code>bathrooms, max_rent_pcm, radius_miles, furnished, accessibility, client_account, enquiry_ref, sell_rate_nightly</code>.
    Dates as YYYY-MM-DD or DD/MM/YYYY. <a href="/api/template.csv">Download template</a>.</p>
    <input type="file" id="bf" accept=".csv,.xlsx"> <button id="bu">Upload &amp; queue</button> <span id="bst" class="muted"></span>
  </div>
  <div class="card"><h2>Uploads<span class="sp"></span><button class="sec" onclick="loadBatches()">Refresh</button></h2><div id="bl" class="muted">Loading…</div></div>
  <div class="card" id="bdet" hidden></div>
</section>
<div id="gal" onclick="if(event.target.id==='gal')closeGal()"><div class="bar"><button onclick="galStep(-1)">‹</button><span id="gc"></span><button onclick="galStep(1)">›</button><button onclick="closeGal()">Close ✕</button></div><img id="gi" referrerpolicy="no-referrer" alt=""><div class="strip" id="gs"></div></div>
</main>
<script>
const $=s=>document.querySelector(s), f=$('#f'), out=$('#out'), st=$('#status');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const gbp=n=>n==null?'—':'£'+Math.round(n).toLocaleString('en-GB');
const bedLabel=b=>b==0?'Studio':b+' bed';
let last=null, lastListings=[];
const tokenVal=()=>{ try{ return (f.token&&f.token.value)||localStorage.getItem('jit_token')||''; }catch(e){ return (f.token&&f.token.value)||''; } };
const hdr=(extra={})=>{ const t=tokenVal(); return {...extra, ...(t?{'x-access-token':t}:{})}; };
const api=async(path,opt={})=>{ const r=await fetch(path,{...opt,headers:hdr(opt.headers||{})}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; };
document.querySelectorAll('nav.tabs button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
function showTab(t){ document.querySelectorAll('nav.tabs button').forEach(x=>x.classList.toggle('on',x.dataset.tab===t)); ['search','history','bulk'].forEach(x=>$('#tab-'+x).hidden=x!==t); if(t==='history')loadHistory(); if(t==='bulk')loadBatches(); }
try{const t=localStorage.getItem('jit_token'); if(t&&f.token) f.token.value=t;}catch(e){}
(function(){const d=new Date(Date.now()+7*864e5), e=new Date(Date.now()+97*864e5);f.checkIn.value=d.toISOString().slice(0,10);f.checkOut.value=e.toISOString().slice(0,10);})();

f.onsubmit=async ev=>{
  ev.preventDefault(); const b=$('#go'); b.disabled=true; st.textContent='Searching Rightmove, Zoopla, OnTheMarket and OpenRent… (usually 30–60s, up to 2 minutes)';
  const body=Object.fromEntries(new FormData(f)); const token=body.token; delete body.token;
  try{ if(token) localStorage.setItem('jit_token',token);}catch(e){}
  try{
    const r=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-access-token':token}:{})},body:JSON.stringify(body)});
    const j=await r.json(); if(!r.ok) throw new Error(j.error||r.status);
    last=j; render(j); st.textContent='Done · '+new Date(j.generatedAt).toLocaleTimeString()+(j.id?' · saved':'');
  }catch(e){ st.innerHTML='<span class="bad">'+esc(e.message)+'</span>'; }
  b.disabled=false;
};

function render(j){
  const e=j.economics, q=j.request, bm=j.benchmark;
  const listings=j.listings.filter(l=>l.kind==='listing');
  out.innerHTML=\`
  <div class="card"><h2>\${esc(bedLabel(q.bedrooms))} · \${esc(j.geo?.label||q.location)} · \${esc(q.checkIn)} → \${esc(q.checkOut)}
    \${q.clientAccount?'<span class="pill">'+esc(q.clientAccount)+'</span>':''}\${q.enquiryRef?'<span class="pill">'+esc(q.enquiryRef)+'</span>':''}</h2>
  <div class="kpis">
    <div class="kpi"><small>Stay</small><b>\${e.nights} nights</b><small>\${e.stayMonths} months</small></div>
    <div class="kpi"><small>Likely lease</small><b>\${e.leaseMonths} months</b><small class="\${e.leaseExceedsStay?'warn':''}">\${e.leaseExceedsStay?'~'+e.voidMonths+' mo to re-let':'covers stay'}</small></div>
    <div class="kpi"><small>Market rent (\${bm?'PropertyData':'listings median'})</small><b>\${gbp(e.benchmarkRentPcm)} pcm</b><small>\${bm?.rangePcm?'80% range '+gbp(bm.rangePcm[0])+'–'+gbp(bm.rangePcm[1]):'&nbsp;'}</small></div>
    \${j.ons?\`<div class="kpi"><small>ONS average · \${esc(j.ons.areaName)} (\${esc(j.ons.period)})</small><b>\${gbp(j.ons.avgPcm)} pcm</b><small>\${esc(j.ons.bedsLabel)} · official, \${esc(j.ons.level)}</small></div>\`:''}
    <div class="kpi"><small>Lease cost (incl. setup)</small><b>\${gbp(e.leaseCost)}</b><small>break-even \${gbp(e.breakEvenNightlyStayOnly)}/night on this stay</small></div>
    \${e.revenue!=null?\`<div class="kpi"><small>Stay margin est.</small><b class="\${e.margin<0?'bad':''}">\${gbp(e.margin)}</b><small>\${e.marginPct}% of \${gbp(e.revenue)} revenue</small></div>\`:''}
    <div class="kpi"><small>Found</small><b>\${listings.length} listings</b><small>\${['Rightmove','Zoopla','OnTheMarket','OpenRent'].map(p=>listings.filter(l=>l.portal.includes(p)).length+' '+p).join(' · ')}</small></div>
  </div>
  <ul class="notes">\${[...e.notes,...j.warnings].map(n=>'<li class="warn">'+esc(n)+'</li>').join('')}</ul></div>

  <div class="card"><h2>Listings <span class="muted">(ranked)</span><span class="sp"></span>
    <button class="sec noprint" onclick="csv('listings')">Export CSV</button>
    <button class="sec noprint" onclick="copyShortlist()">Copy shortlist for client</button>
    <button class="sec noprint" onclick="print()">Print</button></h2>
  \${listings.length?table(listings):'<p class="muted">No listings returned for these filters — try a wider radius or remove the max rent.</p>'}</div>


  <div class="card noprint"><h2>Sources</h2>\${j.sources.map(s=>'<span class="pill '+(s.ok?'ok':'w')+'">'+esc(s.source)+': '+(s.ok?(s.count??'')+' ✓'+(s.ms?' '+s.ms+'ms':''):esc(s.skipped||s.error))+'</span>').join(' ')}</div>\`;
}

function table(ls){
  lastListings=ls;
  return \`<div class="tbl"><table><tr><th class="noprint">✓</th><th>Photo</th><th class="n">Score</th><th>Portal</th><th>Address / listing</th><th class="n">Beds</th><th class="n">Baths</th><th class="n">Rent pcm</th><th>Available</th><th>Furnished</th><th>Floor / access</th><th>Agent</th><th>Details</th></tr>
  \${ls.map((l,i)=>\`<tr><td class="noprint"><input type="checkbox" data-i="\${i}" class="pick"></td>
  <td>\${l.images&&l.images.length?'<img class="thumb" loading="lazy" referrerpolicy="no-referrer" src="'+esc(l.images[0])+'" onclick="openGal('+i+')" onerror="this.outerHTML=\\'<div class=nothumb>no photo</div>\\'" alt="">'+(l.images.length>1?'<div class="muted" style="font-size:11px">'+l.images.length+' photos</div>':''):'<div class="nothumb">no photo</div>'}</td>
  <td class="n score">\${l.score}</td><td><span class="pill">\${esc(l.portal)}</span></td>
  <td><b>\${esc(l.address||l.title)}</b>\${l.url?'<div><a target="_blank" rel="noopener" href="'+esc(l.url)+'">Open listing ↗</a></div>':''}\${l.distanceMiles!=null?'<div class="muted">'+l.distanceMiles+' mi away</div>':''}</td>
  <td class="n">\${l.bedrooms??'?'}</td><td class="n">\${l.bathrooms??'?'}</td><td class="n">\${l.rentPcm?gbp(l.rentPcm):'—'}\${l.rentRaw&&/pw/i.test(l.rentRaw)?'<div class="muted">'+esc(l.rentRaw)+'</div>':''}</td>
  <td>\${esc(l.availableFrom||'—')}</td><td>\${esc(l.furnished||'—')}</td>
  <td>\${l.floor?'<b>'+esc(l.floor)+'</b>':'<span class="muted">not stated</span>'}<div>\${(l.access||[]).filter(a=>a!=='ground floor'||!l.floor).map(a=>'<span class="pill a">'+esc(a)+'</span>').join('')}</div></td>
  <td>\${esc(l.agentName||'—')}\${l.agentPhone?'<div><a href="tel:'+esc(l.agentPhone.replace(/\\s/g,''))+'">'+esc(l.agentPhone)+'</a></div>':''}</td>
  <td style="max-width:320px">\${l.address&&l.title!==l.address?'<div>'+esc(l.title)+'</div>':''}\${l.snippet?'<div class="muted">'+esc(l.snippet.slice(0,220))+'</div>':''}\${l.flags.map(x=>'<span class="pill'+(/agreed|only|needs|unverified|too low/.test(x)?' w':'')+'">'+esc(x)+'</span>').join('')}</td></tr>\`).join('')}</table></div>\`;
}

let gl=[],gix=0;
function openGal(i){ gl=lastListings[i].images||[]; gix=0; if(!gl.length)return; $('#gal').style.display='flex'; drawGal(); }
function drawGal(){ $('#gi').src=gl[gix]; $('#gc').textContent=(gix+1)+' / '+gl.length; $('#gs').innerHTML=gl.map((u,k)=>'<img referrerpolicy="no-referrer" src="'+esc(u)+'" class="'+(k===gix?'on':'')+'" onclick="gix='+k+';drawGal()">').join(''); }
function galStep(d){ gix=(gix+d+gl.length)%gl.length; drawGal(); }
function closeGal(){ $('#gal').style.display='none'; }
document.addEventListener('keydown',e=>{ if($('#gal').style.display==='flex'){ if(e.key==='Escape')closeGal(); if(e.key==='ArrowRight')galStep(1); if(e.key==='ArrowLeft')galStep(-1);} });

async function loadHistory(){
  const q=$('#hq').value.trim(); $('#hist').textContent='Loading…';
  try{ const j=await api('/api/searches?limit=100'+(q?'&q='+encodeURIComponent(q):''));
    $('#hist').innerHTML=j.searches.length?'<div class="tbl"><table><tr><th>When</th><th>Source</th><th>Location</th><th class="n">Beds</th><th>Dates</th><th>Access</th><th>Client / ref</th><th class="n">Listings</th><th class="n">Median rent</th><th class="n">ONS avg</th></tr>'+
      j.searches.map(s=>'<tr class="clk" onclick="openSaved(\\''+s.id+'\\')"><td>'+esc(new Date(s.created_at).toLocaleString('en-GB'))+'</td><td><span class="pill q">'+esc(s.source)+'</span></td><td><b>'+esc(s.location)+'</b><div class="muted">'+esc([s.outcode,s.la_name].filter(Boolean).join(' · '))+'</div></td><td class="n">'+esc(bedLabel(s.bedrooms))+'</td><td>'+esc(s.check_in)+' → '+esc(s.check_out)+'</td><td>'+(s.accessibility&&s.accessibility!=='any'?'<span class="pill a">'+esc(s.accessibility.replace('_',' '))+'</span>':'—')+'</td><td>'+esc([s.client_account,s.enquiry_ref].filter(Boolean).join(' · ')||'—')+'</td><td class="n">'+s.listing_count+'</td><td class="n">'+gbp(s.median_rent_pcm)+'</td><td class="n">'+gbp(s.ons_pcm)+'</td></tr>').join('')+'</table></div>':'<p>No saved searches yet.</p>';
  }catch(e){ $('#hist').innerHTML='<span class="bad">'+esc(e.message)+'</span>'; }
}
$('#hq').addEventListener('keydown',e=>{ if(e.key==='Enter') loadHistory(); });
async function openSaved(id){
  try{ const j=await api('/api/searches/'+id); last=j; showTab('search'); render(j); st.textContent='Saved search from '+new Date(j.savedAt).toLocaleString('en-GB')+' (not re-run)'; window.scrollTo(0,0); }
  catch(e){ alert(e.message); }
}

let bTimer=null;
$('#bu').onclick=async()=>{
  const file=$('#bf').files[0]; if(!file){ $('#bst').textContent='Choose a CSV or XLSX first.'; return; }
  $('#bst').textContent='Uploading…';
  try{ const fd=new FormData(); fd.append('file',file); const j=await api('/api/batches',{method:'POST',body:fd});
    $('#bst').innerHTML=j.batchId?'<span class="ok">Queued '+j.queued+' row(s).</span>'+(j.invalid.length?' <span class="warn">'+j.invalid.length+' skipped: '+esc(j.invalid.map(x=>'row '+x.row+' – '+x.error).join('; '))+'</span>':''):'<span class="bad">Nothing queued: '+esc(j.invalid.map(x=>'row '+x.row+' – '+x.error).join('; '))+'</span>';
    loadBatches(); if(j.batchId) openBatch(j.batchId);
  }catch(e){ $('#bst').innerHTML='<span class="bad">'+esc(e.message)+'</span>'; }
};
async function loadBatches(){
  try{ const j=await api('/api/batches');
    $('#bl').innerHTML=j.batches.length?'<div class="tbl"><table><tr><th>Uploaded</th><th>File</th><th>Status</th><th class="n">Done</th><th class="n">Errors</th><th class="n">Listings found</th><th></th></tr>'+
      j.batches.map(b=>'<tr><td>'+esc(new Date(b.created_at).toLocaleString('en-GB'))+'</td><td>'+esc(b.filename)+'</td><td><span class="pill '+(b.status==='done'?'ok':'w')+'">'+esc(b.status)+'</span></td><td class="n">'+(b.done||0)+' / '+b.total+'</td><td class="n">'+(b.errors||0)+'</td><td class="n">'+(b.listings||0)+'</td><td><button class="sec" onclick="openBatch(\\''+b.id+'\\')">View</button> <a href="/api/batches/'+b.id+'.csv">CSV</a></td></tr>').join('')+'</table></div>':'<p>No uploads yet.</p>';
    if(j.batches.some(b=>b.status!=='done')){ clearTimeout(bTimer); bTimer=setTimeout(()=>{ if(!$('#tab-bulk').hidden){ loadBatches(); const open=$('#bdet').dataset.id; if(open) openBatch(open,true);} },15000); }
  }catch(e){ $('#bl').innerHTML='<span class="bad">'+esc(e.message)+'</span>'; }
}
async function openBatch(id,quiet){
  try{ const b=await api('/api/batches/'+id); const d=$('#bdet'); d.hidden=false; d.dataset.id=id;
    d.innerHTML='<h2>'+esc(b.filename)+' <span class="pill '+(b.status==='done'?'ok':'w')+'">'+esc(b.status)+'</span><span class="sp"></span><a href="/api/batches/'+id+'.csv">Download all results (CSV)</a></h2><div class="tbl"><table><tr><th>Row</th><th>Location</th><th class="n">Beds</th><th>Dates</th><th>Access</th><th>Ref</th><th>Status</th><th class="n">Listings</th><th></th></tr>'+
      b.rows.map(r=>'<tr><td>'+r.row_no+'</td><td>'+esc(r.request.location)+'</td><td class="n">'+esc(bedLabel(r.request.bedrooms))+'</td><td>'+esc(r.request.checkIn)+' → '+esc(r.request.checkOut)+'</td><td>'+esc((r.request.accessibility||'any').replace('_',' '))+'</td><td>'+esc(r.request.enquiryRef||'')+'</td><td><span class="pill '+(r.status==='done'?'ok':r.status==='error'?'w':'q')+'">'+esc(r.status)+'</span>'+(r.error?'<div class="bad" style="font-size:11px">'+esc(r.error)+'</div>':'')+'</td><td class="n">'+(r.listing_count??'')+'</td><td>'+(r.search_id?'<button class="sec" onclick="openSaved(\\''+r.search_id+'\\')">Open</button>':'')+'</td></tr>').join('')+'</table></div>';
  }catch(e){ if(!quiet) alert(e.message); }
}

function picked(){const ls=last.listings.filter(l=>l.kind==='listing');const ix=[...document.querySelectorAll('.pick:checked')].map(c=>+c.dataset.i);return ix.length?ix.map(i=>ls[i]):ls;}
function csv(kind){
  const q=last.request; let rows,head;
  {head=['score','portal','address','title','bedrooms','bathrooms','rentPcm','rentRaw','availableFrom','furnished','agentName','agentPhone','agentEmail','floor','access','distanceMiles','url','images','snippet','flags'];rows=picked();}
  const c=v=>'"'+String(Array.isArray(v)?v.join('; '):v??'').replace(/"/g,'""')+'"';
  const text=[head.join(','),...rows.map(r=>head.map(h=>c(r[h])).join(','))].join('\\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv'}));
  a.download=\`jit-\${kind}-\${(q.enquiryRef||q.location).replace(/\\W+/g,'-')}-\${q.checkIn}.csv\`;a.click();
}
function copyShortlist(){
  const q=last.request, ls=picked().slice(0,10);
  const t=\`Options for \${bedLabel(q.bedrooms)} in \${last.geo?.label||q.location}, \${q.checkIn} to \${q.checkOut}\${q.clientAccount?' ('+q.clientAccount+')':''}:\\n\\n\`+
    ls.map((l,i)=>\`\${i+1}. \${l.title}\${l.address?' — '+l.address:''}\${l.bathrooms?' · '+l.bathrooms+' bath':''}\${l.furnished?' · '+l.furnished:''}\${l.availableFrom?' · available '+l.availableFrom:''}\`).join('\\n')+
    '\\n\\nSubject to availability and contract. Final nightly rates to follow.';
  navigator.clipboard.writeText(t).then(()=>{st.textContent='Client shortlist copied (no rents/agent details included).';});
}
</script></body></html>`;
}
