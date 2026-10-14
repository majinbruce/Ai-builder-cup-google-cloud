(function(){
const INK='#ffe7ce';let BG='#141410';let ACC='#d8dc6a';
const A=o=>`rgba(255,231,206,${o})`;
const MONO='"Inter Tight", sans-serif',SERIF='"Newsreader", Georgia, serif',SANS='"Inter Tight", system-ui, sans-serif',HI='"Tiro Devanagari Hindi", "Noto Sans Devanagari", serif';
const cl=(x,a=0,b=1)=>Math.max(a,Math.min(b,x)),ph=(t,s,e)=>cl((t-s)/(e-s)),eo=x=>1-Math.pow(1-x,3),eio=x=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2,lerp=(a,b,p)=>a+(b-a)*p;
const GL='XS80#@+x';
let F=1,K=1,TT=0;
function hash(a,b){let h=(a*374761393+b*668265263)|0;h=(h^(h>>>13))*1274126177;return (h^(h>>>16))>>>0;}
function scr(word,p,seed,t){if(p>=1)return word;const ch=Array.from(word),n=ch.length,q=Math.floor(t*18);return ch.map((c,i)=>c===' '?' ':(p>(i+1)/(n+1)?c:GL[hash(i+seed,q)%GL.length])).join('');}
function glyphs(n,seed,t){let s='';const q=Math.floor(t*18);for(let i=0;i<n;i++)s+=GL[hash(i+seed,q)%GL.length];return s;}
function al(c,x){c.globalAlpha=F*cl(x);}
function font(c,size,fam,w,st){c.font=`${st||''} ${w||400} ${size*K}px ${fam}`;c.letterSpacing=fam===MONO?(size*K*.07).toFixed(2)+'px':'0px';}
function tx(c,s,x,y,o){o=o||{};font(c,o.size||12,o.fam||SANS,o.w,o.st);c.fillStyle=o.col||INK;c.textAlign=o.align||'left';c.textBaseline=o.base||'alphabetic';al(c,o.a==null?1:o.a);c.fillText(s,x,y);const m=c.measureText(s).width;al(c,1);return m;}
function mw(c,s,size,fam,w,st){font(c,size,fam,w,st);return c.measureText(s).width;}
function label(c,s,x,y,a,col){let sd=0;for(const ch of s)sd=(sd*31+ch.charCodeAt(0))&1023;return tx(c,scr(s,ph(TT,.15,.9),sd,TT),x,y,{size:9.5,fam:MONO,w:500,col:col||INK,a:a==null?.5:a});}
function amp(u,seed){return cl(Math.abs(Math.sin(u*37+seed)*.55+Math.sin(u*91+seed*2)*.3+Math.sin(u*13+seed*3)*.35)*.9+.08);}
function wave(c,x0,x1,yc,H,seed,o){o=o||{};const st=4*K,gaps=o.gaps||[],peaks=o.peaks||[],flat=o.flat||[],head=o.head==null?1:o.head;
  for(let x=x0;x<=x1;x+=st){const u=(x-x0)/(x1-x0);if(o.cut&&u>head)break;let a=amp(u,seed);
    for(const g of gaps){const d=Math.abs(u-g);if(d<.03)a*=d<.02?.03:.3;}
    for(const p of peaks){const d=Math.abs(u-p);if(d<.035)a=Math.max(a,1-d*9);}
    for(const f of flat){if(u>f[0]&&u<f[1])a=Math.min(a,.3);}
    if(o.env)a*=o.env(u);
    const bh=Math.max(1.5*K,a*H);c.fillStyle=u<=head?(o.on||INK):(o.off||A(.16));al(c,1);c.fillRect(x,yc-bh/2,2*K,bh);}}
function dash(c,x0,y0,x1,y1,col,a){al(c,a==null?1:a);c.strokeStyle=col||A(.4);c.lineWidth=1;c.setLineDash([3*K,3*K]);c.beginPath();c.moveTo(x0,y0);c.lineTo(x1,y1);c.stroke();c.setLineDash([]);al(c,1);}
function line(c,x0,y0,x1,y1,col,a,lw){al(c,a==null?1:a);c.strokeStyle=col||A(.3);c.lineWidth=(lw||1)*K;c.beginPath();c.moveTo(x0,y0);c.lineTo(x1,y1);c.stroke();al(c,1);}
function box(c,x,y,w,h,col,a,fill){al(c,a==null?1:a);if(fill){c.fillStyle=fill;c.fillRect(x,y,w,h);}if(col){c.strokeStyle=col;c.lineWidth=1;c.strokeRect(Math.round(x)+.5,Math.round(y)+.5,Math.max(1,Math.round(w)-1),Math.max(1,Math.round(h)-1));}al(c,1);}
function tbox(c,x,y,w,h,o){o=o||{};const a=o.a==null?1:o.a;box(c,x,y,w,h,o.col||A(.88),a,o.fill===false?null:(o.fill||'rgba(13,13,3,0.42)'));if(o.tl)tx(c,o.tl,x+5*K,y+10*K,{size:7.5,fam:MONO,w:500,a:a*.85});if(o.br)tx(c,o.br,x+w-5*K,y+h-5*K,{size:7.5,fam:MONO,w:500,align:'right',a:a*.85});}
function layout(c,words,fs,fam,st,maxW,gap){font(c,fs,fam,400,st);const sp=gap*K,lines=[[]];let lw=0;words.forEach(wd=>{const ww=c.measureText(wd).width;if(lw+ww>maxW&&lines[lines.length-1].length){lines.push([]);lw=0;}lines[lines.length-1].push({wd,ww});lw+=ww+sp;});return lines.map(l=>({items:l,width:l.reduce((s,o)=>s+o.ww,0)+sp*(l.length-1)}));}
function def(P,fn){return (c,w,h,T)=>{K=w/560;c.globalAlpha=1;c.fillStyle=BG;c.fillRect(0,0,w,h);const t=T%P;TT=t;F=ph(t,0,.35)*(1-ph(t,P-.45,P));fn(c,w,h,t);c.globalAlpha=1;c.setLineDash([]);};}

const N={
listenA:def(8.2,(c,w,h,t)=>{
  const P=28*K;label(c,'LISTEN · THE LECTURE ITSELF',P,30*K);
  const head=eio(ph(t,.5,7.2));tx(c,'00:'+(41+head*19).toFixed(1).padStart(4,'0'),w-P,30*K,{size:9.5,fam:MONO,w:500,a:.5,align:'right'});
  const x0=P,x1=w-P,yc=h*.4,H=h*.22,B=[0,.28,.52,.78,1],L=['DEFINING','EXAMPLE','WARNING','RECAP'],pk=[.13,.4,.65,.9],pv=['+4.1','+3.6','+5.0','+3.2'];
  const EV=[[0,.82],[.28,.58],[.52,1],[.78,.68]],env=u=>{let e=.82;for(const v of EV)if(u>=v[0])e=v[1];return e*(.78+.22*Math.sin(u*23+1.7))*(.85+.15*Math.sin(u*61));};
  wave(c,x0,x1,yc,H,1.3,{gaps:[.28,.52,.78],peaks:pk,head,env});
  const sy=h*.68,sh=34*K;
  for(let i=0;i<4;i++){if(head<=B[i])continue;const xs=x0+(x1-x0)*B[i]+(i?3*K:0),xe=x0+(x1-x0)*Math.min(head,B[i+1])-(head>=B[i+1]&&i<3?3*K:0),act=head<B[i+1];
    box(c,xs,sy,Math.max(1,xe-xs),sh,act?INK:A(.35),1);
    c.save();c.beginPath();c.rect(xs,sy,Math.max(0,xe-xs),sh);c.clip();tx(c,L[i],xs+9*K,sy+sh/2,{size:9.5,fam:MONO,w:500,base:'middle',a:ph(head,B[i],B[i]+.04)*(act?1:.55)});c.restore();}
  const px=x0+(x1-x0)*head;line(c,px,yc-H*.62,px,sy+sh+8*K,ACC,head>0&&head<1?1:0);
  label(c,'WHAT THE TEACHER IS DOING',P,h*.93,.35);
}),
listenB:def(7.6,(c,w,h,t)=>{
  const P=28*K;label(c,'LISTEN · EVERY CLAIM, MEASURED',P,30*K);
  const W=['A','derivative','tells','you','how','fast','things','change.'],Lv=[.32,.86,.38,.3,.42,.92,.36,.58],claim={1:1,5:1,7:1},gap=9,th=.7;
  let fs=21,tw;for(;;){tw=W.reduce((s,x)=>s+mw(c,x,fs,SERIF),0)+gap*K*(W.length-1);if(tw<w-2*P||fs<12)break;fs-=1;}
  let x=(w-tw)/2;const wy=h*.3,yb=h*.84,MH=h*.4,ty=yb-MH*th,f0=ph(t,.3,.8);
  dash(c,P,ty,w-P,ty,A(.5),f0);const tl='FFMPEG · LOUDNESS THRESHOLD';label(c,tl,w-P-mw(c,tl,9.5,MONO,500),ty-8*K,.5*f0);
  line(c,P,yb,w-P,yb,A(.25));
  const c0=ph(t,2.2,2.7);let j=0;
  W.forEach((wd,i)=>{const ww=mw(c,wd,fs,SERIF),cx=x+ww/2,isC=!!claim[i],vt=isC?3.4+(j++)*.7:99,v=ph(t,vt,vt+.25),pass=Lv[i]>=th;
    const g=eo(ph(t,.5+i*.1,1.7+i*.1)),bw=Math.min(ww*.55,20*K),bh=Lv[i]*MH*g;
    al(c,1);c.fillStyle=isC&&v>0?(pass?ACC:A(.2)):A(.3);c.fillRect(cx-bw/2,yb-bh,bw,bh);
    tx(c,wd,x,wy,{size:fs,fam:SERIF,col:isC&&v>0&&pass?ACC:INK,a:(isC&&v>0&&!pass?.4:.92)*ph(t,.1,.5)});
    if(isC){const by=wy-fs*K-6*K;line(c,x,by,x+ww,by,ACC,c0*(v>0&&!pass?.3:1));line(c,x,by,x,by+4*K,ACC,c0*(v>0&&!pass?.3:1));line(c,x+ww,by,x+ww,by+4*K,ACC,c0*(v>0&&!pass?.3:1));
      if(v<=0)tx(c,'claimed',cx,by-7*K,{size:8.5,fam:MONO,col:ACC,align:'center',a:c0});
      else tx(c,(pass?'✓ ':'✕ ')+Lv[i].toFixed(2),cx,by-7*K,{size:8.5,fam:MONO,col:pass?ACC:INK,align:'center',a:v*(pass?1:.5)});
      if(v>0&&!pass)line(c,x,wy-fs*K*.32,x+ww*v,wy-fs*K*.32,INK,.6);}
    x+=ww+gap*K;});
}),
planA:def(9.4,(c,w,h,t)=>{
  const P=28*K;label(c,'PLAN · A BRIEF BEFORE A SINGLE WORD',P,30*K);
  const bx=w*.11,by=h*.14,bw=w*.78,bh=h*.76;box(c,bx,by,bw,bh,A(.25),1);
  const S={l:[9.5,MONO,500,A(.5)],t:[13.5,SANS,400,INK],h:[15,HI,400,INK],g:[9.5,MONO,500,ACC]};
  const LN=[[['BRIEF · CLIP 03 / CALCULUS','l']],[],[['TEACHER    ','l'],['calm, explains through analogies','t']],[['REGISTER   ','l'],['formal Hindi, ','t'],['आप','h'],[' form','t']],[],[['GLOSSARY · ONE FOR THE WHOLE CLIP','l']],[['derivative  →  ','t'],['अवकलज','h'],['   TRANSLATED','g']],[['slope  →  ','t'],['स्लोप','h'],['   TRANSLITERATED','g']],[['Newton  →  ','t'],['Newton','t'],['   KEPT AS ENGLISH','g']]];
  let n=(t-.5)*30,y=by+40*K,cur=null;const lx=bx+26*K;
  for(const ln of LN){let x=lx;for(const [s,k] of ln){if(n<=0)break;const st=S[k],vis=k==='h'?(n>=s.length?s:''):s.slice(0,Math.floor(n));n-=s.length;font(c,st[0],st[1],st[2]);c.fillStyle=st[3];c.textAlign='left';c.textBaseline='alphabetic';al(c,1);c.fillText(vis,x,y);x+=c.measureText(vis).width;cur=[x,y];}
    if(n<=0)break;y+=(ln.length?30:14)*K;}
  if(cur&&Math.floor(t*2.4)%2===0){al(c,1);c.fillStyle=INK;c.fillRect(cur[0]+2*K,cur[1]-12*K,1.5*K,15*K);}
}),
planB:def(8.6,(c,w,h,t)=>{
  const P=28*K;label(c,'PLAN · ONE GLOSSARY FOR THE WHOLE CLIP',P,30*K);
  const T=[{en:'derivative',out:'अवकलज',col:0,why:'NCERT term'},{en:'slope',out:'स्लोप',col:1,why:'what students say'},{en:'Newton',out:'Newton',col:2,why:'proper noun'},{en:'limit',out:'सीमा',col:0,why:'everyday word'},{en:'graph',out:'ग्राफ़',col:1,why:'loanword'},{en:'chain rule',out:'chain rule',col:2,why:'exam keyword'}];
  const HD=['TRANSLATED','TRANSLITERATED','KEPT AS ENGLISH'],cx=i=>w*(2*i+1)/6,hy=h*.47;
  HD.forEach((s,i)=>{label(c,s,cx(i)-mw(c,s,9.5,MONO,500)/2,hy,.55);if(i)line(c,w*i/3,hy-16*K,w*i/3,h*.92,A(.12));});
  line(c,P,hy+12*K,w-P,hy+12*K,A(.12));
  const cnt=[0,0,0];
  const pos=T.map((o,i)=>{const slot=cnt[o.col]++,s=1+i*.75,p=eio(ph(t,s,s+.7)),sx=w*(i+.5)/6,sy=h*.25,ex=cx(o.col),ey=hy+52*K+slot*68*K;return {s,p,x:lerp(sx,ex,p),y:lerp(sy,ey,p)-Math.sin(p*Math.PI)*22*K};});
  for(let i=1;i<pos.length;i++){const q=ph(t,pos[i].s,pos[i].s+.25);if(q>0)line(c,pos[i-1].x,pos[i-1].y,pos[i].x,pos[i].y,INK,.22*q);}
  T.forEach((o,i)=>{const {s,p,x,y}=pos[i];
    const r=ph(t,s+.75,s+1.25),hi=/[^\x00-\x7f]/.test(o.out);let s1,fam=SANS,fs=13;
    if(r<=0)s1=o.en;else if(r>=1){s1=o.out;if(hi){fam=HI;fs=15;}}else if(hi){s1=glyphs(Math.max(3,o.en.length-3),i*7,t);fam=MONO;fs=12;}else s1=scr(o.out,r,i*7,t);
    const tw=mw(c,s1,fs,fam),bw=Math.max(tw+22*K,72*K),bh=38*K,lg=o.col===2?'EN':'HI';
    tbox(c,x-bw/2,y-bh/2,bw,bh,{col:p>=1?A(.88):A(.4),fill:BG,tl:r<=0?'EN':(r<1?'EN→'+lg:lg)});tx(c,s1,x,y+4*K,{size:fs,fam,align:'center',base:'middle'});
    const q=ph(t,s+1.3,s+1.7);if(q>0)tx(c,o.why,x,y+bh/2+14*K,{size:9,fam:MONO,a:.5*q,align:'center'});});
}),
reteachA:def(10,(c,w,h,t)=>{
  const P=28*K;label(c,'RE-TEACH · FOR INTENT, NOT WORD FOR WORD',P,30*K);
  const D=[{en:'It’s a piece of cake.',lit:'यह केक का एक टुकड़ा है।',ad:'यह बाएँ हाथ का खेल है।',why:'Idiom replaced with its Hindi equivalent.'},{en:'Let’s break it down.',lit:'चलो इसे तोड़ते हैं।',ad:'चलो इसे कदम-दर-कदम समझते हैं।',why:'“Break” here means explain, not destroy.'}];
  const i=Math.floor(t/5)%2,u=t%5,d=D[i],f=ph(u,0,.3)*(1-ph(u,4.55,5));
  const ol='ORIGINAL · EN';label(c,ol,w/2-mw(c,ol,9.5,MONO,500)/2,h*.22,.5*f);
  tx(c,d.en,w/2,h*.33,{size:28,fam:SERIF,st:'italic',w:600,align:'center',a:f*ph(u,.1,.5)});
  const cw=(w-2*P-22*K)/2,lx=P,rx=P+cw+22*K,by=h*.47,bh=66*K,a1=f*ph(u,.8,1.1),a2=f*ph(u,1.4,1.7),r=ph(u,1.6,2.4);
  tbox(c,lx,by,cw,bh,{col:A(.3),a:a1,tl:'LITERAL',fill:false});
  line(c,lx+cw,by+bh/2,rx,by+bh/2,INK,.4*a2);
  tbox(c,rx,by,cw,bh,{a:a2,tl:r<1?'EN→HI':'ADAPTED',br:r>=1?'INTENT':''});
  const fit=s=>{let fs=17;while(mw(c,s,fs,HI)>cw-24*K&&fs>10)fs-=.5;return fs;};
  tx(c,d.lit,lx+12*K,by+42*K,{size:fit(d.lit),fam:HI,a:.5*f*ph(u,.9,1.3)});
  tx(c,r>=1?d.ad:glyphs(Math.round(Array.from(d.ad).length*.55),i*13,t),rx+12*K,by+42*K,{size:r>=1?fit(d.ad):13,fam:r>=1?HI:MONO,a:f*ph(u,1.6,1.8)});
  const q=ph(u,2.7,3.2),ry=h*.84;line(c,P,ry,P+(w-2*P)*eo(q),ry,A(.2),f);
  label(c,'WHY',P,ry+24*K,.5*f*q,ACC);tx(c,d.why,P+40*K,ry+24*K,{size:12.5,a:f*q});
}),
reteachB:def(7.4,(c,w,h,t)=>{
  const P=28*K;label(c,'RE-TEACH · KEY TERMS STAY STRESSED',P,30*K);
  const EN=['A','derivative','tells','you','how','fast','something','changes.'],HN=['अवकलज','बताता','है','कि','कोई','चीज़','कितनी','तेज़ी','से','बदलती','है।'];
  const out=t<2.9,words=out?EN:HN,fam=out?SERIF:HI,fs=out?27:25,st=out?'italic':'',gp=out?8:7;
  const L=layout(c,words,fs,fam,st,w-2*P-20*K,gp),lh=fs*K*1.55;let y=h*.47-(L.length-1)*lh/2,idx=0;
  L.forEach(l=>{let x=(w-l.width)/2;l.items.forEach(o=>{const i=idx++,stress=i===(out?1:0);let s=o.wd,f2=fam,sz=fs,s2=st;
      if(out){const p=1-ph(t,2.2+i*.04,2.75);if(p<1)s=scr(o.wd,p,i,t);}
      else{const rv=3.3+i*.06;if(t<rv){s=glyphs(Math.max(2,Math.round(Array.from(o.wd).length*.7)),i+40,t);f2=MONO;sz=17;s2='';}}
      const a=out?ph(t,.1,.5):ph(t,2.9,3.05);
      tx(c,s,x,y,{size:sz,fam:f2,st:s2,col:stress?ACC:INK,a});
      if(stress){al(c,a);c.fillStyle=ACC;c.fillRect(x,y+9*K,o.ww,1.5*K);al(c,1);}
      x+=o.ww+gp*K;});y+=lh;});
  const q=ph(t,4.1,4.5);if(q>0){const y2=h*.82,s1='STRESS KEPT   derivative  →  ',w1=mw(c,s1,9.5,MONO,500),w2=mw(c,'अवकलज',14,HI);const x=(w-w1-w2)/2;label(c,s1,x,y2,.6*q);tx(c,'अवकलज',x+w1,y2+1*K,{size:14,fam:HI,col:ACC,a:q});}
}),
gradeA:def(11,(c,w,h,t)=>{
  const P=28*K;label(c,'GRADE · A SEPARATE CALL, BLIND TO THE REASONING',P,30*K);
  const D=[{hi:'अवकलज बदलाव की गति बताता है।',bt:'The derivative tells the speed of change.',s:62},{hi:'अवकलज बताता है कि चीज़ कितनी तेज़ी से बदलती है।',bt:'The derivative tells how fast a thing changes.',s:86}];
  const d=t<5.5?0:1,u=d?t-5.5:t,o=D[d],f=d?1:(1-ph(u,5,5.5));
  label(c,'HINDI · DRAFT '+(d+1),P,h*.2,.5*f);
  let fs=17;while(mw(c,o.hi,fs,HI)>w-2*P&&fs>10)fs-=.5;tx(c,o.hi,P,h*.28,{size:fs,fam:HI,a:f*ph(u,.1,.5)});
  label(c,'BACK-TRANSLATION',P,h*.41,.5*f*ph(u,.8,1));
  if(u>1){let bs=18;while(mw(c,o.bt,bs,SERIF,400,'italic')>w-2*P&&bs>10)bs-=.5;tx(c,scr(o.bt,ph(u,1,1.9),d*50,t),P,h*.49,{size:bs,fam:SERIF,st:'italic',a:f});}
  const by=h*.62,x0=P,bw=w-2*P,a1=f*ph(u,1.9,2.1);label(c,'SCORE',P,by-12*K,.5*a1);
  box(c,x0,by,bw,6*K,null,a1,A(.1));
  const sp=eo(ph(u,2.1,3.2)),sv=o.s*sp,pass=o.s>=70;
  al(c,f);c.fillStyle=sp>=1?(pass?ACC:A(.45)):INK;c.fillRect(x0,by,bw*sv/100,6*K);al(c,1);
  const x70=x0+bw*.7;line(c,x70,by-6*K,x70,by+12*K,INK,a1);label(c,'70',x70-6*K,by+26*K,.5*a1);
  tx(c,String(Math.round(sv)),P,h*.8,{size:42,fam:SERIF,w:300,a:f*ph(u,2.1,2.2)});
  const q=ph(u,3.4,3.7);tx(c,pass?'PASS':'UNDER 70 · REWRITE ONCE',w-P,h*.78,{size:10,fam:MONO,w:500,align:'right',col:pass?INK:ACC,a:f*q});
  if(d)label(c,'DRAFT 1 · 62 · REWRITTEN, STILL SHOWN',P,h*.92,.4*ph(u,.2,.6));
}),
gradeB:def(9.4,(c,w,h,t)=>{
  const P=28*K;label(c,'GRADE · EVERY SEGMENT, SCORED BLIND',P,30*K);
  const S1=[88,74,61,92,79,55,83,90],S2={2:81,5:77},x0=P+54*K,x1=w-P-34*K,bw=x1-x0,y0=h*.2,rh=(h*.86-y0)/8,x70=x0+bw*.7,a0=ph(t,.2,.6);
  dash(c,x70,y0-8*K,x70,y0+rh*7.6,A(.5),a0);label(c,'70',x70-6*K,y0-14*K,.5*a0);
  S1.forEach((s,i)=>{const y=y0+rh*i+rh*.4;label(c,'SEG '+String(i+1).padStart(2,'0'),P,y+3*K,.5);
    box(c,x0,y-2*K,bw,4*K,null,1,A(.08));
    const g=eo(ph(t,.5+i*.22,1.1+i*.22)),fail=s<70;let v=s*g,col=A(.75),num=Math.round(v),ncol=INK;
    if(fail){if(t>3.3){col=A(.28);ncol=ACC;}
      if(t>4.6){const rs=eo(ph(t,4.8,5.6));al(c,.6);c.fillStyle=A(.6);c.fillRect(x0+bw*s/100-.75*K,y-6*K,1.5*K,12*K);al(c,1);v=S2[i]*rs;col=rs>=1?ACC:INK;num=Math.round(v);ncol=rs>=1?ACC:INK;}
      const qa=ph(t,3.4,3.7)*(1-ph(t,5.3,5.7)),qb=ph(t,5.7,6.1);
      tx(c,'REWRITE',x0+bw*s/100+8*K,y-7*K,{size:8.5,fam:MONO,w:500,col:ACC,a:qa});
      tx(c,'WAS '+s,x0+bw*s/100+8*K,y-7*K,{size:8.5,fam:MONO,w:500,a:.45*qb});}
    al(c,1);c.fillStyle=col;c.fillRect(x0,y-2*K,bw*v/100,4*K);
    let ns=String(num);if(fail&&t>4.6&&t<5.6)ns=glyphs(2,i*3,t);
    if(fail&&t>5.6)tbox(c,x1+8*K,y-10*K,28*K,20*K,{a:ph(t,5.6,5.9),fill:false});
    tx(c,ns,x1+32*K,y+4*K,{size:11,fam:MONO,align:'right',col:ncol,a:g>0?1:0});});
}),
speakA:def(9,(c,w,h,t)=>{
  const P=28*K;label(c,'SPEAK · THE EXACT MARKUP SENT TO THE VOICE',P,30*K);
  const L=[[0,[['<speak>','m']]],[1,[['<prosody rate="94%">','m']]],[2,[['अवकलज बताता है कि चीज़ें','h']]],[2,[['<break time="320ms"/>','b']]],[2,[['<emphasis>','m'],['कितनी तेज़ी','h'],['</emphasis>','m']]],[2,[['से बदलती हैं।','h']]],[1,[['</prosody>','m']]],[0,[['</speak>','m']]]];
  const SP=[[2,0,.42],[3,.42,.54],[4,.54,.78],[5,.78,1]],head=ph(t,1,6.4);let act=-1;SP.forEach(s=>{if(head>s[1]&&head<=s[2]&&head<1)act=s[0];});
  const y0=h*.13,lh=25*K;
  L.forEach(([ind,segs],i)=>{const y=y0+lh*(i+1),a=ph(t,.2+i*.06,.5+i*.06);
    if(i===act)tbox(c,P,y-lh*.72,w-2*P,lh,{fill:A(.05),tl:'VOICE'});
    let x=P+22*K+ind*18*K;segs.forEach(([s,k])=>{x+=tx(c,s,x,y,k==='h'?{size:15,fam:HI,a}:{size:11,fam:MONO,col:k==='b'?ACC:A(.6),a});});
    if(i===4){const q=ph(head,.78,.82);if(q>0)tx(c,'✕ STRESS NOT PRODUCED',w-P,y,{size:9,fam:MONO,w:500,col:ACC,align:'right',a:q});}});
  const yc=h*.85,H=h*.13,x0=P,x1=w-P,X=u=>x0+(x1-x0)*u;
  line(c,x0,yc,x1,yc,A(.12));
  wave(c,x0,x1,yc,H,2.1,{gaps:[.48],flat:[[.6,.72]],head,cut:true});
  if(head>.5)tx(c,'320 ms',X(.48),yc-H*.5-10*K,{size:9,fam:MONO,col:ACC,align:'center',a:ph(head,.5,.54)});
  if(head>.74){const q=ph(head,.74,.78);line(c,X(.6),yc-H*.5-6*K,X(.72),yc-H*.5-6*K,ACC,q);}
}),
speakB:def(8.4,(c,w,h,t)=>{
  const P=28*K;label(c,'SPEAK · AT THE PACE OF THE ORIGINAL',P,30*K);
  const x0=P,x1=w-P,head=eio(ph(t,.5,6.8)),g=.47,pk=.53,y1=h*.34,y2=h*.68,H=h*.17,X=u=>x0+(x1-x0)*u,ly1=y1-H*.5-16*K,ly2=y2-H*.5-16*K,dq=ph(head,.97,1);
  label(c,'ORIGINAL · EN',P,ly1,.5);label(c,'HINDI · GEMINI TTS',P,ly2,.5);
  tx(c,'6.2 s',x1,ly1,{size:9.5,fam:MONO,w:500,align:'right',a:.6*dq});tx(c,'6.3 s',x1,ly2,{size:9.5,fam:MONO,w:500,align:'right',a:.6*dq});
  wave(c,x0,x1,y1,H,.7,{gaps:[g],peaks:[pk],head});wave(c,x0,x1,y2,H,3.9,{gaps:[g],peaks:[pk],head});
  const q=ph(head,g,g+.04);dash(c,X(g),y1+H*.55,X(g),y2-H*.55,ACC,q);
  tx(c,'pause · 320 ms',X(g)-8*K,(y1+y2)/2+3*K,{size:9.5,fam:MONO,col:ACC,align:'right',a:q});
  const q2=ph(head,pk,pk+.04),bw=58*K,bh=34*K,b1=y1+H*.5+8*K,b2=y2+H*.5+8*K;
  if(q2>0){line(c,X(pk),b1+bh,X(pk),b2,INK,.3*q2);
    tbox(c,X(pk)-bw/2,b1,bw,bh,{a:q2,tl:'EN',fill:BG});tbox(c,X(pk)-bw/2,b2,bw,bh,{a:q2,tl:'HI',fill:BG});
    tx(c,'fast',X(pk),b1+bh*.68,{size:16,fam:SERIF,st:'italic',align:'center',a:q2});tx(c,ph(head,pk,pk+.08)<1?glyphs(4,9,t):'तेज़ी',X(pk),b2+bh*.7,{size:ph(head,pk,pk+.08)<1?12:16,fam:ph(head,pk,pk+.08)<1?MONO:HI,align:'center',a:q2,col:ACC});}
  line(c,X(head),y1-H*.6,X(head),y2+H*.6,ACC,head>0&&head<1?1:0);
})
};
N.setAccent=v=>{if(v)ACC=v;};N.setBg=v=>{if(v)BG=v;};
window.NuaAnims=N;
window.NuaAnimFonts=['400 16px "Tiro Devanagari Hindi"','italic 600 16px "Newsreader"','italic 400 16px "Newsreader"','300 16px "Newsreader"','500 12px "Inter Tight"','400 13px "Inter Tight"'];
})();
