(function(){
const P={blush:[247,200,184],pink:[240,146,150],coral:[234,106,76],amber:[242,172,72],yellow:[234,210,84],chart:[201,207,90],leaf:[124,148,72]};
const GL='XS80#@+x';
function hash(a,b){let h=(a*374761393+b*668265263)|0;h=(h^(h>>>13))*1274126177;return (h^(h>>>16))>>>0;}
const rgba=(c,a)=>`rgba(${c[0]},${c[1]},${c[2]},${a})`;
function blob(x,cx,cy,r,c,a){const g=x.createRadialGradient(cx,cy,0,cx,cy,r);g.addColorStop(0,rgba(c,a));g.addColorStop(.45,rgba(c,a*.55));g.addColorStop(1,rgba(c,0));x.fillStyle=g;x.fillRect(cx-r,cy-r,2*r,2*r);}
let grain=null,lgrain=null;
function getLGrain(){if(lgrain)return lgrain;lgrain=document.createElement('canvas');lgrain.width=lgrain.height=180;const g=lgrain.getContext('2d'),im=g.createImageData(180,180);for(let i=0;i<im.data.length;i+=4){im.data[i]=255;im.data[i+1]=250;im.data[i+2]=240;im.data[i+3]=Math.random()<.35?Math.random()*60:0;}g.putImageData(im,0,0);return lgrain;}
function getGrain(){if(grain)return grain;grain=document.createElement('canvas');grain.width=grain.height=160;const g=grain.getContext('2d'),im=g.createImageData(160,160);for(let i=0;i<im.data.length;i+=4){const v=Math.random()<.5?0:255;im.data[i]=im.data[i+1]=im.data[i+2]=v;im.data[i+3]=Math.random()*34;}g.putImageData(im,0,0);return grain;}
function scr(word,p,seed,t){if(p>=1)return word;const ch=Array.from(word),n=ch.length,q=Math.floor(t*18);return ch.map((c,i)=>c===' '?' ':(p>(i+1)/(n+1)?c:GL[hash(i+seed,q)%GL.length])).join('');}
function glyphs(n,seed,t){let s='';const q=Math.floor(t*18);for(let i=0;i<n;i++)s+=GL[hash(i+seed,q)%GL.length];return s;}
function imgRect(w,h,t,o){const mx=o.mx==null?.5:o.mx,sw=w*1.08,sy=1+.03*Math.sin(t*.4);return [-w*.04+(mx-.5)*w*.05+Math.sin(t*.15)*w*.012,h*(1-sy),sw,h*sy];}
function warpOff(u,w,h,t,o){let d=Math.sin(u*7+t*.9)*.02+Math.sin(u*17-t*1.3)*.008;const mx=o.mx==null?.5:o.mx,hv=o.hov||0;d-=.18*Math.exp(-Math.pow((u-mx)/.15,2))*hv;d+=.05*Math.exp(-Math.pow((Math.abs(u-mx)-.27)/.09,2))*hv;
  for(const r of (o.ripples||[])){const age=t-r.t;if(age<0||age>3.5)continue;const ph=Math.abs(u-r.x)*w/h-age*1.4;d+=.17*Math.sin(ph*9)*Math.exp(-ph*ph*3)*Math.exp(-age*1.1);}return d*h;}
function drawWarp(c,img,w,h,t,o){const r=imgRect(w,h,t,o),iw=img.naturalWidth,ih=img.naturalHeight,N=Math.max(40,Math.round(w/3)),bot=r[1]+r[3];
  for(let i=0;i<N;i++){const dx=Math.floor(i*w/N),dw=Math.floor((i+1)*w/N)-dx;if(dw<=0)continue;const u=(dx+dw/2)/w,sx=(dx-r[0])/r[2]*iw,ssw=dw/r[2]*iw;if(sx+ssw<=0||sx>=iw)continue;
    const cx=Math.max(0,Math.min(iw-ssw,sx)),top=r[1]+warpOff(u,w,h,t,o);c.drawImage(img,cx,0,ssw,ih,dx,top,dw,bot-top);}}
function drawWarpDev(ctx,img,w,h,t,o,st){const s=ctx.getTransform().a,W=Math.round(w*s),H=Math.round(h*s);if(!st.off)st.off=document.createElement('canvas');const of=st.off;if(of.width!==W||of.height!==H){of.width=W;of.height=H;}
  const ox=of.getContext('2d');ox.clearRect(0,0,W,H);const r=imgRect(w,h,t,o);ox.drawImage(img,r[0]*s,r[1]*s,r[2]*s,r[3]*s);
  ctx.save();ctx.setTransform(1,0,0,1,0,0);const cw=2;for(let x=0;x<W;x+=cw){const off=Math.round(warpOff((x+1)/W,w,h,t,o)*s);ctx.drawImage(of,x,0,cw,H,x,off,cw,H-off);}ctx.restore();}
function edgeFade(c,w,h,col){c.save();if(!col)c.globalCompositeOperation='destination-out';const k=a=>col?rgba(col,a):'rgba(0,0,0,'+a+')';
  let gr=c.createLinearGradient(0,0,0,h*.3);gr.addColorStop(0,k(1));gr.addColorStop(1,k(0));c.fillStyle=gr;c.fillRect(0,0,w,h*.3);c.restore();}
const MODES={
  IMG(x,w,h,t,o){if(!o.img||!o.img.complete||!o.img.naturalWidth)return;drawWarp(x,o.img,w,h,t,o);edgeFade(x,w,h,o.base||[13,13,3]);},
  H(x,w,h,t,o){const dk=!!o.dark,mx=o.mx==null?.5:o.mx,Y=[255,229,110],Pk=[250,176,161],R=[203,78,57],c=.5+(mx-.5)*.14+.025*Math.sin(t*.2),br=1+.04*Math.sin(t*.5),k=dk?1:1.05;
    if(dk)x.globalCompositeOperation='lighter';
    const L=[[Pk,-.46,.26,.42,.5],[Y,.47,.26,.38,.5],[Pk,0,.36,.66,.5],[Y,.14,.22,.54,.48],[Y,-.17,.2,.44,.36],[R,.02,.13,.5,dk?.34:.2],[Pk,-.03,.08,.36,.4]];
    L.forEach(([col,off,sg,pk,a],i)=>{const cc=c+off+.012*Math.sin(t*.3+i*1.9);x.beginPath();x.moveTo(0,h);
      for(let X=0;X<=w+2;X+=2){const u=X/w,y=h-h*pk*br*Math.exp(-Math.pow((u-cc)/sg,2))*(1+.03*Math.sin(u*14+t*.6+i));x.lineTo(X,y);}
      x.lineTo(w,h);x.closePath();const gr=x.createLinearGradient(0,h*(1-pk),0,h);gr.addColorStop(0,rgba(col,a*k*.85));gr.addColorStop(1,rgba(col,a*k*.5));x.fillStyle=gr;x.fill();});
    blob(x,w*c,h*1.02,h*.62*br,dk?[255,214,150]:[255,236,150],dk?.32:.3);
    x.globalCompositeOperation='source-over';},
  W(x,w,h,t,o){const mx=o.mx==null?.5:o.mx,Y=[255,229,110],Pk=[250,176,161],R=[203,78,57];
    const L=[[Y,.16,.62,.9,0],[Pk,.3,.72,1.25,1.7],[R,.5,.42,1.05,3.1],[Pk,.66,.7,.8,4.4],[Y,.82,.5,1.4,5.6]];
    L.forEach(([c,by,a,f,ph],i)=>{x.beginPath();x.moveTo(0,h);for(let X=0;X<=w+2;X+=2){const u=X/w,y=h*(by+.1*Math.sin(u*6.283*f+t*(.22+i*.06)+ph)+.045*Math.sin(u*6.283*2.6*f-t*.35+ph*2)-.1*Math.exp(-Math.pow((u-mx)/.2,2)));x.lineTo(X,y);}
      x.lineTo(w,h);x.closePath();const gr=x.createLinearGradient(0,h*(by-.14),0,h);gr.addColorStop(0,rgba(c,a));gr.addColorStop(1,rgba(c,a*.45));x.fillStyle=gr;x.fill();});},
  A(x,w,h,t){const C=[P.blush,P.pink,P.coral,P.amber,P.yellow,P.chart,P.leaf,P.amber,P.coral,P.pink],n=C.length;
    for(let i=0;i<n;i++){const u=(i+.5)/n,cx=(u+.04*Math.sin(t*.21+i*1.7))*w,cy=h*(.98+.2*Math.sin(t*.45-u*7.5)),r=h*(.62+.16*Math.sin(t*.3+i*2.1));blob(x,cx,cy,r,C[i],.8);}},
  B(x,w,h,t,o){const p=o.p||0;(o.bands||[]).forEach((b,i)=>{const c=(b.s+b.e)/2,cx=(o.x0+(o.x1-o.x0)*c)*w,r=h*(.5+(b.e-b.s)*2.4),hit=Math.exp(-Math.pow((p-c)/.07,2));
    blob(x,cx,h*(1.05+.05*Math.sin(t*.6+i)),r*(1+.25*hit),b.rgb,.5+.45*hit);});},
  C(x,w,h,t,o){const mx=o.mx==null?.5:o.mx,my=o.my==null?.5:o.my,cx=w*(.5+.08*Math.sin(t*.12)+(mx-.5)*.2),cy=h*(1.02+(my-.5)*.1),br=1+.05*Math.sin(t*.45);
    const R=[203,78,57],Pk=[250,176,161],Y=[255,229,110];
    blob(x,cx-w*.62,cy+h*.2,h*1.1,Y,.32);blob(x,cx-w*.4,cy+h*.12,h*1.35*br,Pk,.5);blob(x,cx+w*.34,cy+h*.06,h*1.25*br,Y,.46);blob(x,cx-w*.1,cy,h*1.3*br,Pk,.55);blob(x,cx+w*.06,cy+h*.12,h*1.0,R,.3);blob(x,cx+w*.52,cy+h*.16,h*.95,Pk,.38);}
};
const WORDS=[['path','पथ'],['gravity','गुरुत्व'],['descent','अवतरण'],['curve','वक्र'],['fastest','सबसे तेज़']];
function drawWords(ctx,w,h,t){const D=5,i=Math.floor(t/D),u=t%D,wd=WORDS[i%WORDS.length];
  const sx=w*(.2+.6*((hash(i,7)%100)/100)),sy=h*(.58+.2*((hash(i,3)%100)/100)),fade=Math.min(1,u/.3)*(1-Math.max(0,Math.min(1,(u-4.4)/.6)));
  let s,hi=false;if(u<1.3)s=scr(wd[0],(u-.2)/.9,i,t);else if(u<2.5)s=wd[0];else if(u<3.1)s=glyphs(Math.max(3,wd[0].length-2),i,t);else{s=wd[1];hi=true;}
  ctx.font=hi?'400 22px "Tiro Devanagari Hindi", serif':'italic 600 22px "Newsreader", Georgia, serif';
  const tw=ctx.measureText(s).width,bw=Math.max(96,tw+40),bh=58,x0=Math.round(sx-bw/2),y0=Math.round(sy-bh/2);
  ctx.globalAlpha=fade;ctx.fillStyle='rgba(13,13,3,0.78)';ctx.fillRect(x0,y0,bw,bh);ctx.strokeStyle='rgba(255,236,214,.9)';ctx.lineWidth=1;ctx.strokeRect(x0+.5,y0+.5,Math.round(bw)-1,bh-1);
  ctx.fillStyle='#fff3e6';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(s,sx,sy+2);
  ctx.font='500 9px "Inter Tight", sans-serif';ctx.textAlign='left';ctx.fillText(u<2.5?'EN':(u<3.4?'EN→HI':'HI'),x0+7,y0+11);
  ctx.textAlign='right';ctx.fillText((0.62+((hash(i,1)%38)/100)).toFixed(4),x0+bw-7,y0+bh-10);ctx.globalAlpha=1;}
function render(ctx,w,h,t,st,mode,o){o=o||{};
  const lw=Math.max(80,Math.round(w/8)),lh=Math.max(16,Math.round(lw*h/w));if(!st.buf)st.buf=document.createElement('canvas');const b=st.buf;if(b.width!==lw||b.height!==lh){b.width=lw;b.height=lh;}
  const x=b.getContext('2d',{willReadFrequently:true});const BS=o.base||[255,231,206];x.globalAlpha=1;x.fillStyle=rgba(BS,1);x.fillRect(0,0,lw,lh);
  MODES[mode](x,lw,lh,t,o);
  if(o.blur){if(!st.tmp)st.tmp=document.createElement('canvas');const tc=st.tmp;if(tc.width!==lw||tc.height!==lh){tc.width=lw;tc.height=lh;}const tx=tc.getContext('2d');tx.clearRect(0,0,lw,lh);tx.drawImage(b,0,0);x.filter='blur('+o.blur+'px)';x.drawImage(tc,0,0);x.filter='none';}
  const ff=o.fade==null?.6:o.fade;if(ff>0){const g=x.createLinearGradient(0,0,0,lh*ff);g.addColorStop(0,rgba(BS,1));g.addColorStop(1,rgba(BS,0));x.fillStyle=g;x.fillRect(0,0,lw,lh*ff);}
  ctx.clearRect(0,0,w,h);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  if(mode==='IMG'){if(o.img&&o.img.complete&&o.img.naturalWidth){ctx.globalAlpha=o.imgAlpha==null?1:o.imgAlpha;drawWarpDev(ctx,o.img,w,h,t,o,st);ctx.globalAlpha=1;edgeFade(ctx,w,h,null);}}
  else ctx.drawImage(b,0,0,w,h);
  if(o.grain!==false){if(!st.gl)st.gl=document.createElement('canvas');const gc=st.gl;if(gc.width!==Math.round(w)||gc.height!==Math.round(h)){gc.width=Math.round(w);gc.height=Math.round(h);}
    const gx=gc.getContext('2d');gx.globalCompositeOperation='source-over';gx.clearRect(0,0,gc.width,gc.height);gx.fillStyle=gx.createPattern(o.grain==='light'?getLGrain():getGrain(),'repeat');gx.fillRect(0,0,gc.width,gc.height);
    gx.globalCompositeOperation='destination-in';const m=gx.createLinearGradient(0,0,0,gc.height);m.addColorStop(0,'rgba(0,0,0,0)');m.addColorStop(o.grain==='light'?.3:.45,'rgba(0,0,0,0)');m.addColorStop(.85,'rgba(0,0,0,1)');gx.fillStyle=m;gx.fillRect(0,0,gc.width,gc.height);
    ctx.save();ctx.globalAlpha=.6;ctx.drawImage(gc,0,0,w,h);ctx.restore();}
  const d=x.getImageData(0,0,lw,lh).data,cs=o.cs||12,cols=Math.floor(w/cs),rows=Math.floor(h/cs),q=Math.floor(t*5),amt=o.ascii==null?1:o.ascii,ox=(w-cols*cs)/2;
  ctx.font=`500 ${Math.round(cs*.92)}px "Inter Tight", sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
  const SS=new Float32Array(rows*cols),CC=new Uint8ClampedArray(rows*cols*3);
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const px=ox+(i+.5)*cs,py=(j+.5)*cs,k=(Math.min(lh-1,Math.floor(py/h*lh))*lw+Math.min(lw-1,Math.floor(px/w*lw)))*4,n=j*cols+i;
    SS[n]=Math.min(1,(Math.abs(BS[0]-d[k])+Math.abs(BS[1]-d[k+1])+Math.abs(BS[2]-d[k+2]))/(o.dark?260:170));CC[n*3]=d[k];CC[n*3+1]=d[k+1];CC[n*3+2]=d[k+2];}
  const SO=o.halo?SS.slice():null;
  if(o.halo){const dec=o.halo;for(let j=rows-2;j>=0;j--)for(let i=0;i<cols;i++){const n=j*cols+i,b2=n+cols,v=SS[b2]*dec;if(v>SS[n]){SS[n]=v;CC[n*3]=Math.max(CC[n*3],CC[b2*3]*.9);CC[n*3+1]=Math.max(CC[n*3+1],CC[b2*3+1]*.9);CC[n*3+2]=Math.max(CC[n*3+2],CC[b2*3+2]*.9);}}}
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const px=ox+(i+.5)*cs,py=(j+.5)*cs,n=j*cols+i,r=CC[n*3],gg=CC[n*3+1],bb=CC[n*3+2];
    const s=SS[n];if(s<(o.th||.18))continue;const hf=SO&&SO[n]<s*.9?.32*Math.min(1,(SO[n]+.05)/s+.3):1;
    const hh=hash(i,j),f=.5+.5*Math.sin(t*(.8+(hh%97)/40)+(hh%628)/100);let a=s*Math.pow(f,(o.sharp||4)*(o.ramp?1-.55*Math.pow(py/h,3):1))*amt;
    if(o.ramp){const vy=py/h;if(((hh>>>7)%1000)/1000>Math.min(1,Math.pow(vy,o.ramp)*1.15))continue;a*=.15+.85*Math.pow(vy,o.ramp*.8)+.35*Math.pow(vy,4);}if(o.mx!=null){const dx=px/w-o.mx,dy=(py/h-(o.my==null?.5:o.my))*h/w;a*=1+1.6*Math.exp(-(dx*dx+dy*dy)/.006);}
    if(o.ripples)for(const rp of o.ripples){const age=t-rp.t;if(age<0||age>3.5)continue;const dd=Math.hypot(px-rp.x*w,py-rp.y*h),ring=age*1.4*h;a=Math.max(a,s*1.4*Math.exp(-Math.pow((dd-ring)/(h*.1),2))*Math.exp(-age*1.1));}a*=hf;if(a<.04)continue;
    const ch=GL[hash(i+(hh%3===0?q:0),j)%GL.length];
    ctx.fillStyle=o.dark?`rgba(${Math.min(255,r*1.25+50)|0},${Math.min(255,gg*1.25+45)|0},${Math.min(255,bb*1.2+40)|0},${Math.min(1,a)})`:o.ink?`rgba(${r*.42|0},${gg*.42|0},${bb*.42|0},${Math.min(1,a)})`:`rgba(255,252,246,${Math.min(1,a*1.3)})`;ctx.fillText(ch,px,py);}
  if(o.dots){for(let i=0;i<o.dots;i++){const hh=hash(i,91),u=((hh%1000)/1000+t*(.004+(hh%7)*.0015))%1,v=1-(((hh>>>10)%1000)/1000*.7+t*(.01+(hh%5)*.003))%1*.8,rr=(5+(hh%18))*(w/1440+.4),cx=u*w,cy=h*(.25+v*.75),a=(.06+(hh%10)/100)*(.5+.5*Math.sin(t*.7+i));
      const gd=ctx.createRadialGradient(cx,cy,0,cx,cy,rr);const dc=o.dark?'255,226,180':'255,252,244';gd.addColorStop(0,'rgba('+dc+','+a+')');gd.addColorStop(1,'rgba('+dc+',0)');ctx.fillStyle=gd;ctx.fillRect(cx-rr,cy-rr,rr*2,rr*2);}}
  if(o.words)drawWords(ctx,w,h,t);
}
window.NuaGlow={render,scr,glyphs};
})();
