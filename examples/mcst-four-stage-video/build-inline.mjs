import fs from "node:fs";

const svg = fs.readFileSync("assets/mcst-four-stage-chart.svg", "utf8")
  .replace(/^<\?xml[^>]*>\s*/, "")
  .replaceAll('fill="#7B8794"', 'fill="#6D7883"')
  .replace("<svg ", '<svg id="source-chart" class="source-chart" preserveAspectRatio="xMidYMid meet" ');

const html = `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=1680, height=1188">
<title>문화체육관광부 조직 대비 · 4단 대비</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"><\/script>
<style>
@font-face{font-family:"Apple SD Gothic Neo";src:local("Apple SD Gothic Neo")}@font-face{font-family:"Malgun Gothic";src:local("Malgun Gothic")}
*{box-sizing:border-box}html,body{margin:0;width:1680px;height:1188px;overflow:hidden;background:#fff}
#mcst-four-stage{position:relative;width:1680px;height:1188px;overflow:hidden;background:#fff}
.scene-fill,.clip{position:absolute;inset:0}.scene-fill{background:#fff}
#paper-camera{position:absolute;inset:0;width:1680px;height:1188px}
.source-chart{display:block;width:100%;height:100%;overflow:visible;background:#fff}
.column-glow{position:absolute;top:9.4%;bottom:5.9%;border:1px solid rgba(15,118,110,.22);background:linear-gradient(90deg,rgba(227,241,239,0),rgba(227,241,239,.34),rgba(227,241,239,0));background-size:220% 100%;opacity:0;pointer-events:none}
.column-glow:after{content:"";position:absolute;top:0;bottom:0;width:12%;background:linear-gradient(90deg,transparent,rgba(15,118,110,.22),transparent)}
#g1{left:2.86%;width:22.92%}#g2{left:25.77%;width:24.23%}#g3{left:50%;width:24.23%}#g4{left:74.23%;width:22.92%}
</style></head><body>
<div id="mcst-four-stage" data-composition-id="mcst-four-stage" data-start="0" data-duration="14" data-fps="30" data-width="1680" data-height="1188">
<div class="scene-fill"></div><div id="chart-clip" class="clip" data-start="0" data-duration="14" data-track-index="0">
<div id="paper-camera">${svg}<div id="g1" class="column-glow"></div><div id="g2" class="column-glow"></div><div id="g3" class="column-glow"></div><div id="g4" class="column-glow"></div></div>
</div><script>
(function(){"use strict";
const root=document.getElementById("mcst-four-stage"),camera=document.getElementById("paper-camera"),svg=document.getElementById("source-chart");
const parts=Array.from(svg.children).filter(el=>/^(line|rect|text|path)$/i.test(el.tagName));
const bounds=el=>el.getBBox();
const columnFromX=x=>x<108.25?1:x<210?2:x<311.75?3:4;
const columnOf=el=>{const b=bounds(el);if(el.tagName.toLowerCase()==="line"){const x1=Number(el.getAttribute("x1")||b.x),x2=Number(el.getAttribute("x2")||b.x+b.width);if(Math.abs(x2-x1)>4)return columnFromX(Math.max(x1,x2)-.001)}return columnFromX(b.x+b.width/2)};
const isGlobal=el=>{const b=bounds(el);return b.y<30||b.y>282||b.width>350};
const changeStrokes=new Set(["#0F766E","#B45309","#C2410C","#5B21B6","#155E75"]);
const strokeOf=el=>(el.getAttribute("stroke")||"").toUpperCase();
const isStatusText=el=>el.tagName.toLowerCase()==="text"&&/^(신설|폐지)$/.test((el.textContent||"").trim());
const isStatusRect=el=>el.tagName.toLowerCase()==="rect"&&el.nextElementSibling&&isStatusText(el.nextElementSibling);
const isChangeRect=el=>el.tagName.toLowerCase()==="rect"&&el.hasAttribute("stroke-dasharray")&&changeStrokes.has(strokeOf(el));
const rawLines=parts.filter(el=>el.tagName.toLowerCase()==="line"&&!isGlobal(el)&&Number(el.getAttribute("y1")||0)>38&&Number(el.getAttribute("y1")||0)<281);
const isWhiteChangeUnderlay=el=>{if(strokeOf(el)!=="#FFFFFF")return false;const next=el.nextElementSibling;return !!(next&&next.tagName.toLowerCase()==="line"&&changeStrokes.has(strokeOf(next)))};
const changeLines=rawLines.filter(el=>changeStrokes.has(strokeOf(el))||isWhiteChangeUnderlay(el));
const structureLines=rawLines.filter(el=>!changeLines.includes(el));
const nodeCandidates=parts.filter(el=>/^(rect|text)$/i.test(el.tagName)&&!isGlobal(el)&&bounds(el).y>30);
const changeNodes=nodeCandidates.filter(el=>isChangeRect(el)||isStatusText(el)||isStatusRect(el));
const orgNodes=nodeCandidates.filter(el=>!changeNodes.includes(el));
const orgByCol=n=>orgNodes.filter(el=>columnOf(el)===n);
const structureLineCol=n=>structureLines.filter(el=>columnOf(el)===n);
const changeLineColumn=el=>{const x1=Number(el.getAttribute("x1")),x2=Number(el.getAttribute("x2")),mid=(x1+x2)/2;return mid<160?2:mid<260?3:4};
const changeLineCol=n=>changeLines.filter(el=>changeLineColumn(el)===n);
orgNodes.forEach(el=>el.classList.add("hf-org-node"));structureLines.forEach(el=>el.classList.add("hf-structure-line"));changeNodes.forEach(el=>el.classList.add("hf-change-node"));changeLines.forEach(el=>el.classList.add("hf-change-line"));
const orgProof=orgByCol(4).at(-1),changeProof=changeNodes.find(isChangeRect);if(orgProof)orgProof.id="hf-org-proof";if(changeProof)changeProof.id="hf-change-proof";
const tl=gsap.timeline({paused:true});
tl.set(camera,{x:0,y:0,scale:1},0);tl.set(orgNodes,{autoAlpha:0},0);tl.set(structureLines,{autoAlpha:0},0);tl.set(changeNodes,{autoAlpha:0},0);tl.set(changeLines,{autoAlpha:0},0);tl.fromTo(svg,{autoAlpha:0},{autoAlpha:1,duration:.28,ease:"power2.out"},0);
for(let n=1;n<=4;n++){const s=(n-1)*2.2;
tl.fromTo(orgByCol(n),{autoAlpha:0},{autoAlpha:1,duration:.32,stagger:.012,ease:"power2.out",immediateRender:false},s+.10);
const ls=structureLineCol(n),solid=ls.filter(el=>!el.hasAttribute("stroke-dasharray")),dashed=ls.filter(el=>el.hasAttribute("stroke-dasharray"));solid.forEach(el=>{const len=Math.max(1,el.getTotalLength());el.style.strokeDasharray=len;el.style.strokeDashoffset=len});
tl.fromTo(solid,{autoAlpha:0},{autoAlpha:1,strokeDashoffset:0,duration:.50,stagger:.005,ease:"sine.inOut",immediateRender:false},s+1.00);tl.set(solid,{clearProps:"strokeDasharray,strokeDashoffset"},s+1.80);
tl.fromTo(dashed,{autoAlpha:0,strokeDashoffset:12},{autoAlpha:1,strokeDashoffset:0,duration:.40,stagger:.005,ease:"sine.inOut",immediateRender:false},s+1.10);
tl.fromTo("#g"+n,{autoAlpha:0,backgroundPosition:"180% 0"},{autoAlpha:.58,backgroundPosition:"-80% 0",duration:.30,ease:"power1.out",immediateRender:false},s+1.62).to("#g"+n,{autoAlpha:0,duration:.28,ease:"power1.in"},s+1.96);
}
tl.fromTo(changeNodes,{autoAlpha:0},{autoAlpha:1,duration:.34,stagger:.008,ease:"power2.out",immediateRender:false},8.90);
for(let n=2;n<=4;n++){const s=9.15+(n-2)*1.02,ls=changeLineCol(n),solid=ls.filter(el=>!el.hasAttribute("stroke-dasharray")),dashed=ls.filter(el=>el.hasAttribute("stroke-dasharray"));solid.forEach(el=>{const len=Math.max(1,el.getTotalLength());el.style.strokeDasharray=len;el.style.strokeDashoffset=len});
tl.fromTo(solid,{autoAlpha:0},{autoAlpha:1,strokeDashoffset:0,duration:.58,stagger:.006,ease:"sine.inOut",immediateRender:false},s);tl.set(solid,{clearProps:"strokeDasharray,strokeDashoffset"},s+.86);
tl.fromTo(dashed,{autoAlpha:0,strokeDashoffset:14},{autoAlpha:1,strokeDashoffset:0,duration:.66,stagger:.008,ease:"sine.inOut",immediateRender:false},s+.12);
}
tl.set(camera,{x:0,y:0,scale:1},12.40);tl.seek(0);
window.__timelines=window.__timelines||{};window.__timelines["mcst-four-stage"]=tl;
})();
<\/script></div></body></html>`;
fs.writeFileSync("compositions/index.html", html);
