(function(){
const GL='XS80#@+x';
function hash(a,b){let h=(a*374761393+b*668265263)|0;h=(h^(h>>>13))*1274126177;return (h^(h>>>16))>>>0;}
const S={};
function strip(img,W,t,mx,src){
  if(!S.c){S.c=document.createElement('canvas');S.c.width=256;S.c.height=1;S.x=S.c.getContext('2d',{willReadFrequently:true});}
  const iw=img.naturalWidth,ih=img.naturalHeight,r0=-W*.04+(mx-.5)*W*.05+Math.sin(t*.15)*W*.012,r2=W*1.08;
  S.x.clearRect(0,0,256,1);S.x.imageSmoothingQuality='high';if(false){const y0=Math.round(src.height*.84),k=Math.max(2,Math.round(src.height*.05));if(!S.t){S.t=document.createElement('canvas');S.t.width=40;S.t.height=1;S.u=S.t.getContext('2d');}S.u.imageSmoothingEnabled=true;S.u.imageSmoothingQuality='high';S.u.clearRect(0,0,40,1);S.u.drawImage(src,0,y0,src.width,k,0,0,40,1);S.x.imageSmoothingEnabled=true;S.x.drawImage(S.t,0,0,40,1,0,0,256,1);}else S.x.drawImage(img,(0-r0)/r2*iw,ih-4,W/r2*iw,3,0,0,256,1);
  const im=S.x.getImageData(0,0,256,1),p=im.data;for(let i=0;i<256;i++){const a=p[i*4+3]/255;if(a<.02){p[i*4]=p[i*4-4]||242;p[i*4+1]=p[i*4-3]||193;p[i*4+2]=p[i*4-2]||78;}p[i*4+3]=255;}
  S.x.putImageData(im,0,0);return p;}
const sm=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
// k: 0 = gradient still covers the whole seam, 1 = settled (dense at top, sparse below)
function render(ctx,W,H,t,o){
  const img=o.img;ctx.clearRect(0,0,W,H);if(!img||!img.complete||!img.naturalWidth)return;
  const mx=o.mx==null?.5:o.mx,ov=Math.round(o.ov),cs=o.cs||12,mode=o.mode||'Dissolve',k=o.k==null?1:o.k,drift=Math.round(o.drift||0);
  const y0=ov+drift,Hb=H-y0-cs,d=strip(img,W,t,mx,o.src);
  const col=x=>{const q=Math.max(0,Math.min(255,Math.floor(x/W*256)))*4;return [d[q],d[q+1],d[q+2]];};
  const P=y=>{const yy=(y-y0)/Hb;if(yy<0)return 1;if(yy>=1)return 0;return 1-k*(1-Math.pow(Math.max(0,1-yy),1.7));};
  const band=(y,h)=>ctx.drawImage(S.c,0,0,256,1,0,y,W,h);
  band(0,y0+cs);ctx.save();ctx.globalCompositeOperation='destination-out';const g=ctx.createLinearGradient(0,0,0,ov);g.addColorStop(0,'rgba(0,0,0,1)');g.addColorStop(.35,'rgba(0,0,0,.92)');g.addColorStop(.7,'rgba(0,0,0,.55)');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fillRect(0,0,W,ov);ctx.restore();
  const cols=Math.ceil(W/cs),rows=Math.max(0,Math.floor(Hb/cs)),fill=new Float32Array(cols*rows),q=Math.floor(t*1.6);
  ctx.font=`500 ${Math.round(cs*.92)}px "Inter Tight", sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
  if(mode==='Dissolve'&&(o.fx==='Curtain'||o.fx==='Pour')){
    const P1=y=>{const yy=(y-y0)/Hb;return yy<0?1:yy>=1?0:Math.pow(Math.max(0,1-yy),1.7);};
    if(o.fx==='Curtain'){
      for(let j=0;j<rows;j++){const ty=y0+j*cs,p=P1(ty+cs/2),yy=j/rows;for(let i=0;i<cols;i++){const hh=hash(i,j),h2=(hh%4===0?hash(i+q*13,j+q):hh)/4294967296;if(h2>=Math.min(1,p*1.12))continue;
        const x=(i+.5)/cols,front=k*1.35-.05*Math.sin(x*9+1.3)-.04*Math.sin(x*23),u=Math.max(0,Math.min(1,(front-yy)/.12));if(u<=0)continue;
        const e=u<1?1-Math.pow(1-u,3):1,sz=cs*e,c=col((i+.5)*cs),ox2=(cs-sz)/2;ctx.fillStyle=u<1?`rgb(${Math.min(255,c[0]+30)},${Math.min(255,c[1]+30)},${Math.min(255,c[2]+25)})`:`rgb(${c})`;
        ctx.fillRect(Math.floor(i*cs+ox2),Math.floor(ty+ox2),Math.ceil(sz)+1,Math.ceil(sz)+1);if(u>=1)fill[j*cols+i]=.9;}}
    } else {
      for(let i=0;i<cols;i++){const dl=((hash(i,55)%1000)/1000)*.32,u=Math.max(0,Math.min(1,(k-dl)/.62)),hp=u*(Hb+cs*8),c=col((i+.5)*cs);if(u<=0)continue;
        for(let j=0;j<rows;j++){const cy=j*cs;if(cy>hp)break;const ty=y0+cy,p=P1(ty+cs/2),hh=hash(i,j),h2=(hh%4===0?hash(i+q*13,j+q):hh)/4294967296,keep=h2<Math.min(1,p*1.12);
          const a=keep?1:Math.max(0,1-(hp-cy)/(cs*7));if(a<=.02)continue;ctx.fillStyle=`rgba(${c},${a})`;ctx.fillRect(Math.floor(i*cs),Math.floor(ty),Math.ceil(cs)+1,Math.ceil(cs)+1);
          if(keep&&hp-cy>cs)fill[j*cols+i]=.9;else if(a>.4)fill[j*cols+i]=.5;}}
    }
  } else if(mode==='Dissolve'&&o.rain){
    const P1=y=>{const yy=(y-y0)/Hb;return yy<0?1:yy>=1?0:Math.pow(Math.max(0,1-yy),1.7);},top=y0-cs;
    for(let j=0;j<rows;j++){const ty=y0+j*cs,p=P1(ty+cs/2),yy=j/rows;for(let i=0;i<cols;i++){const hh=hash(i,j),h2=(hh%4===0?hash(i+q*13,j+q):hh)/4294967296;
      if(h2>=Math.min(1,p*1.12))continue;const dl=yy*.62+((hash(i,j+31)%1000)/1000)*.18,u=Math.max(0,Math.min(1,(k-dl)/.3));if(u<=0)continue;
      const y=top+(ty-top)*u*u,c=col((i+.5)*cs);ctx.fillStyle=`rgb(${c})`;ctx.fillRect(Math.floor(i*cs),Math.floor(y),Math.ceil(cs)+1,Math.ceil(cs)+1);if(u>=1)fill[j*cols+i]=.9;}}
    const N=Math.round(cols*.18);for(let n=0;n<N;n++){const hh=hash(n,4242),sp=.05+(hh%100)/1000,ph=(hash(n,77)%1000)/1000,uu=(t*sp+ph)%1,x=((hash(n,13)%1000)/1000)*W,yy=uu*.85,a=k*(1-yy/.85)*.9;if(a<.05)continue;
      const c=col(x),sz=Math.max(3,cs*(.35+.25*((hh>>8)%3)/2));ctx.fillStyle=`rgba(${c},${a})`;ctx.fillRect(Math.floor(x/cs)*cs+(cs-sz)/2,y0+yy*Hb,sz,sz*1.6);}
  } else if(mode==='Dissolve'){
    for(let j=0;j<rows;j++){const y=y0+j*cs,p=P(y+cs/2);for(let i=0;i<cols;i++){const hh=hash(i,j),h2=(hh%4===0?hash(i+q*13,j+q):hh)/4294967296;
      if(h2<Math.min(1,p*1.12)){ctx.fillStyle=`rgb(${col((i+.5)*cs)})`;ctx.fillRect(Math.floor(i*cs),Math.floor(y),Math.ceil(cs)+1,Math.ceil(cs)+1);fill[j*cols+i]=.9;}else if(p>.04)fill[j*cols+i]=.3;}}
  } else if(mode==='Halftone'){
    for(let j=0;j<rows;j++){const y=y0+j*cs,p=P(y+cs/2);if(p<.01)continue;for(let i=0;i<cols;i++){const r=cs*.73*Math.sqrt(p)*(.85+.15*((hash(i,j)%100)/100));if(r<.6)continue;
      ctx.fillStyle=`rgb(${col((i+.5)*cs)})`;ctx.beginPath();ctx.arc((i+.5)*cs,y+cs/2,r,0,6.2832);ctx.fill();fill[j*cols+i]=p>.5?.9:.25;}}
  } else if(mode==='Drip'){
    const cw=cs;for(let i=0;i<cols;i++){const hh=hash(i,7),u=(hh%1000)/1000,u2=(hash(i,9)%1000)/1000;
      const L=Hb*(1-k*(1-(.08+.62*Math.pow(u,1.4)*(.75+.25*Math.sin(t*.35+u2*6.28))))),x=i*cw,c=col(x+cw/2);
      const gr=ctx.createLinearGradient(0,y0,0,y0+L);gr.addColorStop(0,`rgba(${c},1)`);gr.addColorStop(.7,`rgba(${c},1)`);gr.addColorStop(1,`rgba(${c},0)`);
      ctx.fillStyle=gr;ctx.fillRect(Math.floor(x),y0,Math.ceil(cw)+1,L);
      for(let j=0;j<rows;j++){const yc=j*cs+cs/2;fill[j*cols+i]=yc<L*.85?.9:yc<L?.35:0;}}
  } else {
    const fall=(t*14)%cs;
    for(let j=-1;j<rows;j++){const y=y0+j*cs+fall,p=P(y+cs/2);if(p<.01||y+cs<y0)continue;const solid=sm((p-.55)/.4);
      for(let i=0;i<cols;i++){const c=col((i+.5)*cs);if(solid>0){ctx.fillStyle=`rgba(${c},${solid})`;ctx.fillRect(Math.floor(i*cs),Math.floor(y),Math.ceil(cs)+1,Math.ceil(cs)+1);}
        const jj=j-Math.floor(t*14/cs),hh=hash(i,jj+500);if((hh%1000)/1000<p*1.05){ctx.fillStyle=`rgba(${c[0]*.78|0},${c[1]*.72|0},${c[2]*.68|0},${Math.min(1,.25+p)})`;ctx.fillText(GL[hash(i+(hh%3===0?Math.floor(t*5):0),jj)%8],(i+.5)*cs,y+cs/2);}}}
  }
  // ascii shimmer, same recipe as the lesson glow
  const ac=Math.floor(W/cs),ar=Math.floor((y0+rows*cs)/cs),qq=Math.floor(t*5),ox=(W-ac*cs)/2;
  for(let j=0;j<ar;j++)for(let i=0;i<ac;i++){const px=ox+(i+.5)*cs,py=(j+.5)*cs;let s;
    if(py<y0)s=py<ov?sm(py/ov)*.5:1;else{if(mode==='Glyph rain')continue;const fj=Math.floor((py-y0)/cs),fi=Math.floor(px/cs);s=fj<rows?fill[fj*cols+fi]:0;}
    if(s<.12)continue;const hh=hash(i,j+977),f=.5+.5*Math.sin(t*(.8+(hh%97)/40)+(hh%628)/100),a=s*Math.pow(f,6)*.75;if(a<.03)continue;
    const c=col(px);ctx.fillStyle=`rgba(${Math.min(255,c[0]*1.25+50)|0},${Math.min(255,c[1]*1.25+45)|0},${Math.min(255,c[2]*1.2+40)|0},${Math.min(1,a)})`;
    ctx.fillText(GL[hash(i+(hh%3===0?qq:0),j)%8],px,py);}
}
window.NuaSeam={render};
})();
