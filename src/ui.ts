export function html(needsToken: boolean): string {
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
@media print{header,form,.noprint{display:none!important}.card{border:none;padding:0}}
</style></head><body>
<header><h1>Just-in-time Inventory Sourcer</h1><span>Find lettable stock when we have an enquiry but no inventory</span></header>
<main>
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
</main>
<script>
const $=s=>document.querySelector(s), f=$('#f'), out=$('#out'), st=$('#status');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const gbp=n=>n==null?'—':'£'+Math.round(n).toLocaleString('en-GB');
const bedLabel=b=>b==0?'Studio':b+' bed';
let last=null;
try{const t=localStorage.getItem('jit_token'); if(t&&f.token) f.token.value=t;}catch(e){}
(function(){const d=new Date(Date.now()+7*864e5), e=new Date(Date.now()+97*864e5);f.checkIn.value=d.toISOString().slice(0,10);f.checkOut.value=e.toISOString().slice(0,10);})();

f.onsubmit=async ev=>{
  ev.preventDefault(); const b=$('#go'); b.disabled=true; st.textContent='Searching Rightmove, Zoopla, OnTheMarket and OpenRent… (usually 30–60s, up to 2 minutes)';
  const body=Object.fromEntries(new FormData(f)); const token=body.token; delete body.token;
  try{ if(token) localStorage.setItem('jit_token',token);}catch(e){}
  try{
    const r=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-access-token':token}:{})},body:JSON.stringify(body)});
    const j=await r.json(); if(!r.ok) throw new Error(j.error||r.status);
    last=j; render(j); st.textContent='Done · '+new Date(j.generatedAt).toLocaleTimeString();
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
  return \`<div class="tbl"><table><tr><th class="noprint">✓</th><th class="n">Score</th><th>Portal</th><th>Address / listing</th><th class="n">Beds</th><th class="n">Baths</th><th class="n">Rent pcm</th><th>Available</th><th>Furnished</th><th>Agent</th><th>Details</th></tr>
  \${ls.map((l,i)=>\`<tr><td class="noprint"><input type="checkbox" data-i="\${i}" class="pick"></td><td class="n score">\${l.score}</td><td><span class="pill">\${esc(l.portal)}</span></td>
  <td><b>\${esc(l.address||l.title)}</b>\${l.url?'<div><a target="_blank" rel="noopener" href="'+esc(l.url)+'">Open listing ↗</a></div>':''}\${l.distanceMiles!=null?'<div class="muted">'+l.distanceMiles+' mi away</div>':''}</td>
  <td class="n">\${l.bedrooms??'?'}</td><td class="n">\${l.bathrooms??'?'}</td><td class="n">\${l.rentPcm?gbp(l.rentPcm):'—'}\${l.rentRaw&&/pw/i.test(l.rentRaw)?'<div class="muted">'+esc(l.rentRaw)+'</div>':''}</td>
  <td>\${esc(l.availableFrom||'—')}</td><td>\${esc(l.furnished||'—')}</td>
  <td>\${esc(l.agentName||'—')}\${l.agentPhone?'<div><a href="tel:'+esc(l.agentPhone.replace(/\\s/g,''))+'">'+esc(l.agentPhone)+'</a></div>':''}</td>
  <td style="max-width:320px">\${l.address&&l.title!==l.address?'<div>'+esc(l.title)+'</div>':''}\${l.snippet?'<div class="muted">'+esc(l.snippet.slice(0,220))+'</div>':''}\${l.flags.map(x=>'<span class="pill'+(/agreed|only|needs|unverified|too low/.test(x)?' w':'')+'">'+esc(x)+'</span>').join('')}</td></tr>\`).join('')}</table></div>\`;
}

function picked(){const ls=last.listings.filter(l=>l.kind==='listing');const ix=[...document.querySelectorAll('.pick:checked')].map(c=>+c.dataset.i);return ix.length?ix.map(i=>ls[i]):ls;}
function csv(kind){
  const q=last.request; let rows,head;
  {head=['score','portal','address','title','bedrooms','bathrooms','rentPcm','rentRaw','availableFrom','furnished','agentName','agentPhone','agentEmail','distanceMiles','url','snippet','flags'];rows=picked();}
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
