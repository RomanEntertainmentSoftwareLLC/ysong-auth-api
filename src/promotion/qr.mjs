// Small dependency-free QR Code Model 2 encoder used only for YSong campaign URLs.
// Byte mode, error correction level M, versions 1-10. Mask 0 is intentionally
// fixed: every generated symbol is standards-valid; mask optimization can be
// added later without changing the public API.

const RS_BLOCKS_M = {
  1: [[1,26,16]], 2: [[1,44,28]], 3: [[1,70,44]], 4: [[2,50,32]], 5: [[2,67,43]],
  6: [[4,43,27]], 7: [[4,49,31]], 8: [[2,60,38],[2,61,39]], 9: [[3,58,36],[2,59,37]],
  10: [[4,69,43],[1,70,44]],
};
const ALIGN = {
  1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30], 6: [6,34],
  7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50],
};

const EXP = new Array(512).fill(0);
const LOG = new Array(256).fill(0);
let x = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
function gfMul(a,b){ return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
function polyMul(a,b){ const out = new Array(a.length+b.length-1).fill(0); for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)out[i+j]^=gfMul(a[i],b[j]); return out; }
function generator(degree){ let p=[1]; for(let i=0;i<degree;i++) p=polyMul(p,[1,EXP[i]]); return p; }
function rsEncode(data, ecCount){ const gen=generator(ecCount); const msg=[...data,...new Array(ecCount).fill(0)]; for(let i=0;i<data.length;i++){ const coef=msg[i]; if(!coef) continue; for(let j=0;j<gen.length;j++) msg[i+j]^=gfMul(gen[j],coef); } return msg.slice(-ecCount); }

class Bits {
  constructor(){ this.bits=[]; }
  put(value,length){ for(let i=length-1;i>=0;i--) this.bits.push(((value>>>i)&1)===1); }
  bytes(){ const out=[]; for(let i=0;i<this.bits.length;i+=8){ let v=0; for(let j=0;j<8;j++) v=(v<<1)|(this.bits[i+j]?1:0); out.push(v); } return out; }
}
function blocksFor(version){ const out=[]; for(const [count,total,data] of RS_BLOCKS_M[version]) for(let i=0;i<count;i++) out.push({total,data}); return out; }
function dataCapacity(version){ return blocksFor(version).reduce((n,b)=>n+b.data,0); }
function chooseVersion(byteLength){ for(let v=1;v<=10;v++){ const countBits=v<10?8:16; const usable=dataCapacity(v)*8 - 4 - countBits; if(byteLength*8 <= usable) return v; } throw new Error("qr_payload_too_large"); }
function createCodewords(text, version){
  const bytes=[...new TextEncoder().encode(text)]; const cap=dataCapacity(version); const bits=new Bits();
  bits.put(0b0100,4); bits.put(bytes.length, version<10?8:16); for(const b of bytes) bits.put(b,8);
  const max=cap*8; for(let i=0;i<Math.min(4,max-bits.bits.length);i++) bits.bits.push(false);
  while(bits.bits.length%8) bits.bits.push(false);
  let pad=true; while(bits.bits.length<max){ bits.put(pad?0xec:0x11,8); pad=!pad; }
  const raw=bits.bytes(); const blocks=blocksFor(version); const dataBlocks=[]; const ecBlocks=[]; let offset=0;
  for(const b of blocks){ const d=raw.slice(offset,offset+b.data); offset+=b.data; dataBlocks.push(d); ecBlocks.push(rsEncode(d,b.total-b.data)); }
  const out=[]; const maxData=Math.max(...dataBlocks.map(b=>b.length)); const maxEc=Math.max(...ecBlocks.map(b=>b.length));
  for(let i=0;i<maxData;i++) for(const b of dataBlocks) if(i<b.length) out.push(b[i]);
  for(let i=0;i<maxEc;i++) for(const b of ecBlocks) if(i<b.length) out.push(b[i]);
  return out;
}
function bchTypeInfo(data){ let d=data<<10; const g=0x537; while((31-Math.clz32(d)) >= (31-Math.clz32(g))) d ^= g << ((31-Math.clz32(d))-(31-Math.clz32(g))); return ((data<<10)|d)^0x5412; }
function bchTypeNumber(data){ let d=data<<12; const g=0x1f25; while((31-Math.clz32(d)) >= (31-Math.clz32(g))) d ^= g << ((31-Math.clz32(d))-(31-Math.clz32(g))); return (data<<12)|d; }
function finder(matrix,reserved,row,col){ const size=matrix.length; for(let r=-1;r<=7;r++)for(let c=-1;c<=7;c++){ const rr=row+r,cc=col+c; if(rr<0||cc<0||rr>=size||cc>=size)continue; reserved[rr][cc]=true; matrix[rr][cc]=(r>=0&&r<=6&&c>=0&&c<=6&&(r===0||r===6||c===0||c===6||(r>=2&&r<=4&&c>=2&&c<=4))); } }
function alignment(matrix,reserved,row,col){ for(let r=-2;r<=2;r++)for(let c=-2;c<=2;c++){ reserved[row+r][col+c]=true; matrix[row+r][col+c]=(Math.max(Math.abs(r),Math.abs(c))!==1); } }
function reserveFormat(matrix,reserved){ const n=matrix.length; for(let i=0;i<15;i++){
  let r,c; if(i<6){r=i;c=8;}else if(i<8){r=i+1;c=8;}else{r=n-15+i;c=8;} reserved[r][c]=true;
  if(i<8){r=8;c=n-i-1;}else if(i<9){r=8;c=15-i;}else{r=8;c=14-i;} reserved[r][c]=true;
 } reserved[n-8][8]=true; matrix[n-8][8]=true; }
function placeFormat(matrix,reserved){ const n=matrix.length; const bits=bchTypeInfo((0b00<<3)|0); for(let i=0;i<15;i++){ const mod=((bits>>i)&1)===1; let r,c;
  if(i<6){r=i;c=8;}else if(i<8){r=i+1;c=8;}else{r=n-15+i;c=8;} matrix[r][c]=mod; reserved[r][c]=true;
  if(i<8){r=8;c=n-i-1;}else if(i<9){r=8;c=15-i;}else{r=8;c=14-i;} matrix[r][c]=mod; reserved[r][c]=true;
 } matrix[n-8][8]=true; }
function reserveVersion(matrix,reserved,version){ if(version<7)return; const n=matrix.length; const bits=bchTypeNumber(version); for(let i=0;i<18;i++){ const mod=((bits>>i)&1)===1; const r=Math.floor(i/3),c=i%3+n-11; matrix[r][c]=mod; reserved[r][c]=true; matrix[c][r]=mod; reserved[c][r]=true; } }
function codewordBits(words){ const bits=[]; for(const w of words) for(let i=7;i>=0;i--) bits.push(((w>>i)&1)===1); return bits; }
export function qrMatrix(text){
  const byteLength=new TextEncoder().encode(String(text)).length; const version=chooseVersion(byteLength); const n=21+(version-1)*4;
  const matrix=Array.from({length:n},()=>Array(n).fill(false)); const reserved=Array.from({length:n},()=>Array(n).fill(false));
  finder(matrix,reserved,0,0); finder(matrix,reserved,n-7,0); finder(matrix,reserved,0,n-7);
  for(const r of ALIGN[version]) for(const c of ALIGN[version]) if(!reserved[r][c]) alignment(matrix,reserved,r,c);
  for(let i=8;i<n-8;i++){ if(!reserved[6][i]){reserved[6][i]=true;matrix[6][i]=(i%2===0);} if(!reserved[i][6]){reserved[i][6]=true;matrix[i][6]=(i%2===0);} }
  reserveFormat(matrix,reserved); reserveVersion(matrix,reserved,version);
  const bits=codewordBits(createCodewords(String(text),version)); let idx=0; let upward=true;
  for(let right=n-1;right>0;right-=2){ if(right===6) right--; for(let step=0;step<n;step++){ const row=upward?n-1-step:step; for(let dx=0;dx<2;dx++){ const col=right-dx; if(reserved[row][col]) continue; let bit=idx<bits.length?bits[idx++]:false; if((row+col)%2===0) bit=!bit; matrix[row][col]=bit; } } upward=!upward; }
  placeFormat(matrix,reserved); return matrix;
}
export function qrSvg(text,{scale=8,margin=4}={}){ const m=qrMatrix(text); const n=m.length; const size=(n+margin*2)*scale; const parts=[]; for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(m[r][c])parts.push(`M${(c+margin)*scale} ${(r+margin)*scale}h${scale}v${scale}h-${scale}z`); return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${parts.join("")}" fill="#000"/></svg>`; }
