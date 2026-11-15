'use strict';

// 预设 17「调音台」(MIXER DESK).
//
// This is a port of the Shadertoy shader at https://www.shadertoy.com/view/cs2GWD (author marker
// 0b5vr). The body below is the reference source, kept as written; the only changes are the
// uniforms that replace a few literal constants (camera pan/zoom/roll, grid scale, level gain,
// march/shadow steps, max distance) and a 1.0 alpha so the post pass can copy it. The reference
// page was not reachable and carried no licence header; the licence is UNVERIFIED and must be
// confirmed with the author before this build is distributed. See 22-mixer-desk-preset.LICENSE.txt,
// NOTICE.md and docs/THIRD_PARTY_PORTS.md.

var MIXER_PRESET_INDEX = 17;

var MIXER_TUNING_SCHEMA = {
  camPan: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  camAnim: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  camRoll: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  camFov: { def: 4, min: 1, max: 10, kind: 'unit', rebuild: 'live' },
  gridScale: { def: 1, min: 0.3, max: 3, kind: 'ratio', rebuild: 'live' },
  levelGain: { def: 1, min: 0, max: 3, kind: 'ratio', rebuild: 'live' },
  audioSmooth: { def: 0.6, min: 0, max: 0.95, kind: 'ratio', rebuild: 'live' },
  marchSteps: { def: 100, min: 24, max: 160, kind: 'count', rebuild: 'live' },
  shadowSteps: { def: 30, min: 0, max: 60, kind: 'count', rebuild: 'live' },
  maxDist: { def: 50, min: 10, max: 120, kind: 'unit', rebuild: 'live' },
  camShake: { def: 0.6, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  camShakeRate: { def: 1, min: 0.1, max: 4, kind: 'ratio', rebuild: 'live' },
  audioDrive: { def: 1, min: 0, max: 2, kind: 'ratio', rebuild: 'live' },
  renderScale: { def: 0.8, min: 0.5, max: 1, kind: 'ratio', rebuild: 'pass' }
};

function mixerParam(key) {
  var store = (typeof mixerTuning !== 'undefined') ? mixerTuning : null;
  if (store && store[key] !== undefined && store[key] !== null) return store[key];
  var spec = MIXER_TUNING_SCHEMA[key];
  return spec ? spec.def : 0;
}

function mixerPresetIsActive() {
  return typeof fx !== 'undefined' && !!fx && Number(fx.preset) === MIXER_PRESET_INDEX;
}

// ---------------------------------------------------------------- the ported fragment

var MIXER_PORT_LINES = [
  "out vec4 outColor;",
  "#define gl_FragColor outColor",
  "uniform float uCamPan;",
  "uniform float uCamAnim;",
  "uniform float uCamRoll;",
  "uniform float uCamFov;",
  "uniform float uGridScale;",
  "uniform float uLevelGain;",
  "uniform float uAudioDrive;",
  "uniform float uSteps;",
  "uniform float uShadowSteps;",
  "uniform float uMaxDist;",
  "uniform float uBeat;",
  "uniform float uShakeAmp;",
  "uniform float uShakeRate;",
  "#define lofi(i,j) (floor((i)/(j))*(j))",
  "#define lofir(i,j) (round((i)/(j))*(j))",
  "",
  "float mLevel(float h){",
  "  return texture(iChannel0, vec2(fract(h), 0.5)).x * uLevelGain * uAudioDrive;",
  "}",
  "",
  "const float PI=acos(-1.);",
  "const float TAU=PI*2.;",
  "",
  "mat2 r2d(float t){",
  "  float c=cos(t),s=sin(t);",
  "  return mat2(c,s,-s,c);",
  "}",
  "",
  "mat3 orthbas(vec3 z){",
  "  z=normalize(z);",
  "  vec3 up=abs(z.y)>.999?vec3(0,0,1):vec3(0,1,0);",
  "  vec3 x=normalize(cross(up,z));",
  "  return mat3(x,cross(z,x),z);",
  "}",
  "",
  "uvec3 pcg3d(uvec3 s){",
  "  s=s*1145141919u+1919810u;",
  "  s.x+=s.y*s.z;",
  "  s.y+=s.z*s.x;",
  "  s.z+=s.x*s.y;",
  "  s^=s>>16;",
  "  s.x+=s.y*s.z;",
  "  s.y+=s.z*s.x;",
  "  s.z+=s.x*s.y;",
  "  return s;",
  "}",
  "",
  "vec3 pcg3df(vec3 s){",
  "  uvec3 r=pcg3d(floatBitsToUint(s));",
  "  return vec3(r)/float(0xffffffffu);",
  "}",
  "",
  "struct Grid{",
  "  vec3 s;",
  "  vec3 c;",
  "  vec3 h;",
  "  int i;",
  "  float d;",
  "};",
  "",
  "Grid dogrid(vec3 ro,vec3 rd){",
  "  Grid r;",
  "  r.s=vec3(2.0*uGridScale,2.0*uGridScale,100.0);",
  "  for(int i=0;i<3;i++){",
  "    r.c=(floor(ro/r.s)+.5)*r.s;",
  "    r.h=pcg3df(r.c);",
  "    r.i=i;",
  "",
  "    if(r.h.x<.4){",
  "      break;",
  "    }else if(i==0){",
  "      r.s=vec3(2.0*uGridScale,1.0*uGridScale,100.0);",
  "    }else if(i==1){",
  "      r.s=vec3(1.0*uGridScale,1.0*uGridScale,100.0);",
  "    }",
  "  }",
  "  ",
  "  vec3 src=-(ro-r.c)/rd;",
  "  vec3 dst=abs(.501*r.s/rd);",
  "  vec3 bv=src+dst;",
  "  float b=min(min(bv.x,bv.y),bv.z);",
  "  r.d=b;",
  "  ",
  "  return r;",
  "}",
  "",
  "float sdbox(vec3 p,vec3 s){",
  "  vec3 d=abs(p)-s;",
  "  return length(max(d,0.))+min(0.,max(max(d.x,d.y),d.z));",
  "}",
  "",
  "float sdbox(vec2 p,vec2 s){",
  "  vec2 d=abs(p)-s;",
  "  return length(max(d,0.))+min(0.,max(d.x,d.y));",
  "}",
  "",
  "vec4 map(vec3 p,Grid grid){",
  "  p-=grid.c;",
  "  p.z+=.4*sin(2.*iTime+1.*fract(grid.h.z*28.)+.3*(grid.c.x+grid.c.y));",
  "  ",
  "  vec3 psize=grid.s/2.;",
  "  psize.z=1.;",
  "  psize-=.02;",
  "  float d=sdbox(p+vec3(0,0,1),psize)-.02;",
  "  ",
  "  float pcol=1.;",
  "",
  "  vec3 pt=p;",
  "  ",
  "  if(grid.i==0){//2x2",
  "    if(grid.h.y<.3){//speaker",
  "      vec3 c=vec3(0);",
  "      pt.xy*=r2d(PI/4.);",
  "      c.xy=lofir(pt.xy,.1);",
  "      pt=pt-c;",
  "      pt.xy*=r2d(-PI/4.);",
  "      ",
  "      float r=.02*smoothstep(.9,.7,abs(p.x))*smoothstep(.9,.7,abs(p.y));",
  "      float hole=length(pt.xy)-r;",
  "      d=max(d,-hole);",
  "    }else if(grid.h.y<.5){//eq",
  "      vec3 c=vec3(0);",
  "      c.x=clamp(lofir(pt.x,.2),-.6,.6);",
  "      pt-=c;",
  "      float hole=sdbox(pt.xy,vec2(0.,.7))-.03;",
  "      d=max(d,-hole);",
  "      ",
  "      float drv=mLevel(grid.h.z*1.93+.37); pt.y-=.5-smoothstep(-.5,.5,sin(iTime+c.x+grid.h.z*100.)) - (drv-.5)*.7;",
  "      float d2=sdbox(pt,vec3(.02,.07,.07))-.03;",
  "      ",
  "      if(d2<d){",
  "        float l=step(abs(pt.y),.02);",
  "        return vec4(d2,2.*l,l,0);",
  "      }",
  "      ",
  "      pt=p;",
  "      c.y=clamp(lofir(pt.y,.2),-.6,.6);",
  "      pt-=c;",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy,vec2(.07,.0))-.005);",
  "",
  "      pt=p;",
  "      c.y=clamp(lofir(pt.y,.6),-.6,.6);",
  "      pt-=c;",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy,vec2(.1,.0))-.01);",
  "      ",
  "      pcol=mix(1.,pcol,smoothstep(.0,.01,sdbox(pt.xy,vec2(.03,1.))-.01));",
  "",
  "    }else if(grid.h.y<.6){//kaosspad",
  "      float hole=sdbox(p.xy,vec2(.9,.9)+.02);",
  "      d=max(d,-hole);",
  "",
  "      float d2=sdbox(p,vec3(.9,.9,.05));",
  "",
  "      if(d2<d){",
  "        float l=step(abs(p.x),.7)*step(abs(p.y),.7);",
  "        return vec4(d2,4.*l,0,0);",
  "      }",
  "    }else if(grid.h.y<1.){//bigass knob",
  "      float ani=smoothstep(-.5,.5,sin(iTime+grid.h.z*100.)); float drv=mLevel(grid.h.z*1.37+.11);",
  "      pt.xy*=r2d(PI/6.*5.*mix(-1.,1.,ani) + (drv-.5)*1.7);",
  "",
  "      float metal=step(length(pt.xy),.45);",
  "      float wave=metal*sin(length(pt.xy)*500.)/1000.;",
  "      float d2=length(pt.xy)-.63+.05*pt.z-.02*cos(8.*atan(pt.y,pt.x));",
  "      d2=max(d2,abs(pt.z)-.4-wave);",
  "",
  "      float d2b=length(pt.xy)-.67+.05*pt.z;",
  "      d2b=max(d2b,abs(pt.z)-.04);",
  "      d2=min(d2,d2b);",
  "      ",
  "      if(d2<d){",
  "        float l=smoothstep(.01,.0,length(pt.xy-vec2(0,.53))-.03);",
  "        return vec4(d2,3.*metal,l,0);",
  "      }",
  "      ",
  "      pt=p;",
  "      float a=clamp(lofir(atan(-pt.x,pt.y),PI/12.),-PI/6.*5.,PI/6.*5.);",
  "      pt.xy*=r2d(a);",
  "      pcol*=smoothstep(.0,.01,length(pt.xy-vec2(0,.74))-.015);",
  "",
  "      pt=p;",
  "      a=clamp(lofir(atan(-pt.x,pt.y),PI/6.*5.),-PI/6.*5.,PI/6.*5.);",
  "      pt.xy*=r2d(a);",
  "      pcol*=smoothstep(.0,.01,length(pt.xy-vec2(0,.74))-.03);",
  "      ",
  "      float d3=length(p-vec3(.7,-.7,0))-.05;",
  "      ",
  "      if(d3<d){",
  "        float led=1.-ani;",
  "        led*=(.5+.5*sin(iTime*exp2(3.+3.*grid.h.z)))*(.35+.65*mLevel(grid.h.z*2.3+.41));",
  "        return vec4(d3,2,led,0);",
  "      }",
  "    }",
  "  }else if(grid.i==1){//2x1",
  "    if(grid.h.y<.4){//fader",
  "      float hole=sdbox(p.xy,vec2(.9,.05));",
  "      d=max(d,-hole);",
  "      ",
  "      float ani=smoothstep(-.2,.2,sin(iTime+grid.h.z*100.)); float drv=mLevel(grid.h.z*1.71+.23);",
  "      pt.x-=mix(-.8,.8,clamp(ani*.65+drv*.45,0.,1.));",
  "      ",
  "      float d2=sdbox(pt,vec3(.07,.25,.4))+.05*p.z;",
  "      d2=max(d2,-p.z);",
  "",
  "      if(d2<d){",
  "        float l=smoothstep(.01,.0,abs(p.y)-.02);",
  "        return vec4(d2,0,l,0);",
  "      }",
  "      ",
  "      pt=p;",
  "      vec3 c=vec3(0);",
  "      c.x=clamp(lofir(pt.x,.2),-.8,.8);",
  "      pt-=c;",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy,vec2(.0,.15))-.005);",
  "",
  "      pt=p;",
  "      c=vec3(0);",
  "      c.x=clamp(lofir(pt.x,.8),-.8,.8);",
  "      pt-=c;",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy,vec2(.0,.18))-.01);",
  "      ",
  "      pcol=mix(1.,pcol,smoothstep(.0,.01,sdbox(p.xy,vec2(1.,.08))));",
  "    }else if(grid.h.y<.5){//button",
  "      vec3 c=vec3(0);",
  "      c.x=clamp(lofi(pt.x,.44)+.44/2.,-.44*1.5,.44*1.5);",
  "      pt-=c;",
  "",
  "      float hole=sdbox(pt.xy,vec2(.19,.33))-.01;",
  "      d=max(d,-hole);",
  "      ",
  "      float ani=smoothstep(.8,.9,sin(10.*iTime-c.x*2.2+grid.h.z*100.)); ani=clamp(ani+mLevel(grid.h.z*2.17+.31)*.7,0.,1.);",
  "",
  "      vec4 fuck=vec4(d,0,0,0);",
  "      float d3=length(pt-vec3(0,.22,.04))-.05;",
  "      ",
  "      if(d3<fuck.x){",
  "        float led=ani;",
  "        fuck=vec4(d3,2,led,0);",
  "      }",
  "",
  "      float d2=sdbox(pt,vec3(.17,.3,.05))-.01;",
  "      d2=min(d2,sdbox(pt-vec3(0,-.1,0),vec3(.17,.2,.08))-.01)+.5*pt.z;",
  "",
  "      if(d2<fuck.x){",
  "        fuck=vec4(d2,5,fract(grid.h.z*8.89),0);",
  "      }",
  "      ",
  "      if(fuck.x<d){",
  "        return fuck;",
  "      }",
  "      ",
  "    }else if(grid.h.y<1.){//meter",
  "      float hole=sdbox(p.xy,vec2(.9,.3)+.02);",
  "      d=max(d,-hole);",
  "",
  "      float d2=sdbox(p,vec3(.9,.3,.1));",
  "",
  "      if(d2<d){",
  "        float l=step(abs(p.x),.8)*step(abs(p.y),.2);",
  "        return vec4(d2,l,0,0);",
  "      }",
  "    }",
  "  }else{//1x1",
  "    if(grid.h.y<.5){//knob",
  "      float hole=length(p.xy)-.25;",
  "      d=max(d,-hole);",
  "      ",
  "      float ani=smoothstep(-.5,.5,sin(2.*iTime+grid.h.z*100.)); float drv=mLevel(grid.h.z*1.51+.29);",
  "      pt.xy*=r2d(PI/6.*5.*mix(-1.,1.,ani) + (drv-.5)*1.7);",
  "      ",
  "      float d2=length(pt.xy)-.23+.05*pt.z;",
  "      d2=max(d2,abs(pt.z)-.4);",
  "      ",
  "      if(d2<d){",
  "        float l=smoothstep(.01,.0,abs(pt.x)-.015);",
  "        l*=smoothstep(.01,.0,-pt.y+.05);",
  "        return vec4(d2,0,l,0);",
  "      }",
  "      ",
  "      pt=p;",
  "      float a=clamp(lofir(atan(-pt.x,pt.y),PI/6.),-PI/6.*5.,PI/6.*5.);",
  "      pt.xy*=r2d(a);",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy-vec2(0,.34),vec2(.0,.02))-.005);",
  "",
  "      pt=p;",
  "      a=clamp(lofir(atan(-pt.x,pt.y),PI/6.*5.),-PI/6.*5.,PI/6.*5.);",
  "      pt.xy*=r2d(a);",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy-vec2(0,.34),vec2(.0,.03))-.01);",
  "    }else if(grid.h.y<.8){//jack",
  "      float hole=length(p.xy)-.1;",
  "      d=max(d,-hole);",
  "      ",
  "      float d2=length(p.xy)-.15;",
  "      d2=max(d2,abs(p.z)-.12);",
  "      ",
  "      pt.xy*=r2d(100.*grid.h.z);",
  "      float d3=abs(pt.y)-.2;",
  "      pt.xy*=r2d(PI/3.*2.);",
  "      d3=max(d3,abs(pt.y)-.2);",
  "      pt.xy*=r2d(PI/3.*2.);",
  "      d3=max(d3,abs(pt.y)-.2);",
  "      d3=max(d3,abs(p.z)-.03);",
  "",
  "      d2=min(d2,d3);",
  "      d2=max(d2,-hole);",
  "      ",
  "      if(d2<d){",
  "        return vec4(d2,3,0,0);",
  "      }",
  "    }else if(grid.h.y<.99){//button",
  "      pt.y+=.08;",
  "      ",
  "      float hole=sdbox(pt.xy,vec2(.22))-.05;",
  "      d=max(d,-hole);",
  "      ",
  "      float ani=sin(2.*iTime+grid.h.z*100.);",
  "      float push=smoothstep(.3,.0,abs(ani));",
  "      ani=smoothstep(-.1,.1,ani);",
  "      pt.z+=.06*push;",
  "",
  "      float d2=sdbox(pt,vec3(.2,.2,.05))-.05;",
  "",
  "      if(d2<d){",
  "        return vec4(d2,0,0,0);",
  "      }",
  "      ",
  "      float d3=length(p-vec3(0,.3,0))-.05;",
  "      ",
  "      if(d3<d){",
  "        float led=ani;",
  "        return vec4(d3,2,led,0);",
  "      }",
  "    }else if(grid.h.y<1.){//0b5vr",
  "      pt=abs(pt);",
  "      pt.xy=pt.x<pt.y?pt.yx:pt.xy;",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy,vec2(.05)));",
  "      pcol*=smoothstep(.0,.01,sdbox(pt.xy-vec2(.2,0),vec2(.05,.15)));",
  "      pcol=1.-pcol;",
  "    }",
  "  }",
  "  ",
  "  return vec4(d,0,pcol,0);",
  "}",
  "",
  "vec3 nmap(vec3 p,Grid grid,float dd){",
  "  vec2 d=vec2(0,dd);",
  "  return normalize(vec3(",
  "    map(p+d.yxx,grid).x-map(p-d.yxx,grid).x,",
  "    map(p+d.xyx,grid).x-map(p-d.xyx,grid).x,",
  "    map(p+d.xxy,grid).x-map(p-d.xxy,grid).x",
  "  ));",
  "}",
  "",
  "struct March{",
  "  vec4 isect;",
  "  vec3 rp;",
  "  float rl;",
  "  Grid grid;",
  "};",
  "",
  "March domarch(vec3 ro,vec3 rd,int iter){",
  "  float rl=1E-2;",
  "  vec3 rp=ro+rd*rl;",
  "  vec4 isect;",
  "  Grid grid;",
  "  float gridlen=rl;",
  "  ",
  "  for(int i=0;i<iter;i++){",
  "    if(gridlen<=rl){",
  "      grid=dogrid(rp,rd);",
  "      gridlen+=grid.d;",
  "    }",
  "    ",
  "    isect=map(rp,grid);",
  "    rl=min(rl+isect.x*.8,gridlen);",
  "    rp=ro+rd*rl;",
  "    ",
  "    if(abs(isect.x)<1E-4){break;}",
  "    if(rl>uMaxDist){break;}",
  "  }",
  "  ",
  "  March r;",
  "  r.isect=isect;",
  "  r.rp=rp;",
  "  r.rl=rl;",
  "  r.grid=grid;",
  "  ",
  "  return r;",
  "}",
  "",
  "void mainImage( out vec4 fragColor, in vec2 fragCoord )",
  "{",
  "  vec2 uv = vec2(fragCoord.x / iResolution.x, fragCoord.y / iResolution.y);",
  "  vec2 p=uv*2.-1.;",
  "  p.x*=iResolution.x/iResolution.y;",
  "  float shk=uBeat*uShakeAmp*.02;",
  "  p+=vec2(sin(iTime*uShakeRate*8.7),cos(iTime*uShakeRate*7.3))*shk;",
  "  p=r2d(cos(iTime*uShakeRate*5.3)*shk*.8)*p;",
  "",
  "  vec3 col=vec3(0);",
  "",
  "  float canim=smoothstep(-.2,.2,sin(iTime*uCamAnim));",
  "  vec3 co=mix(vec3(-6,-8,-40),vec3(0,-2,-40),canim);",
  "  vec3 ct=vec3(0,0,-50);",
  "  float cr=mix(.5,.0,canim)*uCamRoll;",
  "  co.xy+=iTime*uCamPan;",
  "  ct.xy+=iTime*uCamPan;",
  "  mat3 cb=orthbas(co-ct);",
  "  vec3 ro=co+cb*vec3(uCamFov*p*r2d(cr),0);",
  "  vec3 rd=cb*normalize(vec3(0,0,-2));",
  "  ",
  "  March march=domarch(ro,rd,int(uSteps));",
  "  ",
  "  if(march.isect.x<1E-2){",
  "    vec3 basecol=vec3(.5);",
  "    vec3 speccol=vec3(.2);",
  "    float specpow=30.;",
  "    float ndelta=1E-4;",
  "    ",
  "    float mtl=march.isect.y;",
  "    float mtlp=march.isect.z;",
  "    float drv=mLevel(march.grid.h.z*2.1+.37);",
  "    if(mtl==0.){",
  "      mtlp=mix(mtlp,1.-mtlp,step(fract(march.grid.h.z*66.),.1));",
  "      vec3 c=.9+.0*sin(.1*(march.grid.c.x+march.grid.c.y)+march.grid.h.z+vec3(0,2,3));",
  "      basecol=mix(vec3(.04),c,mtlp)*(.75+.5*drv);",
  "    }else if(mtl==1.){",
  "      basecol=vec3(0);",
  "      speccol=vec3(.5);",
  "      specpow=60.;",
  "      ",
  "      vec2 size=vec2(.05,.2);",
  "      vec2 pp=(march.rp-march.grid.c).xy;",
  "      vec2 c=lofi(pp.xy,size)+size/2.;",
  "      vec2 cc=pp-c;",
  "      vec3 led=vec3(1);",
  "      led*=exp(-60.*sdbox(cc,vec2(0.,.08)));",
  "      led*=c.x>.5?vec3(5,1,2):vec3(1,5,2);",
  "      float lv=mLevel(march.grid.h.z*1.13+.07);",
  "      col+=led*step(c.x,-.8+1.6*lv);",
  "      basecol=.04*led;",
  "    }else if(mtl==2.){//led",
  "      basecol=vec3(0);",
  "      speccol=vec3(1.);",
  "      specpow=100.;",
  "      ",
  "      col+=mtlp*vec3(2,.5,.5)*(.4+.6*drv);",
  "    }else if(mtl==3.){//metal",
  "      basecol=vec3(.2)+vec3(.06)*drv;",
  "      speccol=vec3(1.8);",
  "      specpow=100.;",
  "      ndelta=3E-2;",
  "    }else if(mtl==4.){//kaoss",
  "      basecol=vec3(0);",
  "      speccol=vec3(.5);",
  "      specpow=60.;",
  "      ",
  "      vec2 size=vec2(.1);",
  "      vec2 pp=(march.rp-march.grid.c).xy;",
  "      vec2 c=lofi(pp.xy,size)+size/2.;",
  "      vec2 cc=pp-c;",
  "      vec3 led=vec3(1);",
  "      led*=exp(-60.*sdbox(cc,vec2(0.,.0)));",
  "      led*=vec3(2,1,2);",
  "      float plasma=sin(length(c)*10.-10.*iTime+march.grid.h.z*.7);",
  "      plasma+=sin(c.y*10.-7.*iTime); plasma*=(.7+.6*mLevel(march.grid.h.z*2.7+.53));",
  "      led*=.5+.5*sin(plasma);",
  "      col+=2.*led*(.4+.6*drv);",
  "      basecol=.04*led;",
  "    }else if(mtl==5.){//808",
  "      basecol=vec3(.9,mtlp,.02)*(.35+.65*drv);",
  "    }",
  "    ",
  "    vec3 n=nmap(march.rp,march.grid,ndelta);",
  "    vec3 v=-rd;",
  "    ",
  "    {",
  "      vec3 l=normalize(vec3(1,3,5));",
  "      vec3 h=normalize(l+v);",
  "      float dotnl=max(0.,dot(n,l));",
  "      float dotnh=max(0.,dot(n,h));",
  "      float shadow=step(1E-1,domarch(march.rp,l,int(uShadowSteps)).isect.x);",
  "      vec3 diff=basecol/PI;",
  "      vec3 spec=speccol*pow(dotnh,specpow);",
  "      col+=vec3(.5,.6,.7)*shadow*dotnl*(diff+spec);",
  "    }",
  "    {",
  "      vec3 l=normalize(vec3(-1,-1,5));",
  "      vec3 h=normalize(l+v);",
  "      float dotnl=max(0.,dot(n,l));",
  "      float dotnh=max(0.,dot(n,h));",
  "      float shadow=step(1E-1,domarch(march.rp,l,int(uShadowSteps)).isect.x);",
  "      vec3 diff=basecol/PI;",
  "      vec3 spec=speccol*pow(dotnh,specpow);",
  "      col+=shadow*dotnl*(diff+spec);",
  "    }",
  "  }",
  "  ",
  "  col=pow(col,vec3(.4545));",
  "  col=smoothstep(vec3(0,-.1,-.2),vec3(1,1.1,1.2),col);",
  "  fragColor = vec4(col,1.0);",
  "}",
  "",
  "",
];

var MIXER_PORT_BODY = MIXER_PORT_LINES.join('\n');

var MIXER_BLIT_VS = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = vec4(position.xy, 0.999999, 1.0);',
  '}'
].join('\n');

// Pass-through blit: the reference already applies its own gamma and tone curve.
var MIXER_BLIT_FS = [
  'precision highp float;',
  'uniform sampler2D tDiffuse;',
  'uniform float uVignette;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
  '  float vig = distance(vUv, vec2(0.5));',
  '  c *= 1.0 - uVignette * smoothstep(0.35, 0.85, vig);',
  '  gl_FragColor = vec4(c, 1.0);',
  '}'
].join('\n');

// ---------------------------------------------------------------- iChannel0: 64-bin spectrum

var MIXER_BINS = 64;
var mixerLevelState = {
  level: new Float32Array(MIXER_BINS),
  peak: new Float32Array(MIXER_BINS)
};

function mixerClamp01(value) {
  var n = Number(value);
  return !isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
}

// Log-spaced bin -> FFT index, so the low end is not squeezed into one texel.
function mixerSpectrumIndex(bin, bins) {
  var n = (typeof frequencyData !== 'undefined' && frequencyData && frequencyData.length) ? frequencyData.length : 0;
  if (!n) return 0;
  var t = Math.pow(n, Math.max(0, Math.min(1, bin / Math.max(1, bins - 1))));
  return Math.min(n - 1, Math.max(0, Math.floor(t)));
}

function mixerBandValues(frame) {
  var out = new Float32Array(8);
  if (frame && (frame.sonicDetailed || frame.subBass !== undefined)) {
    out[0] = Number(frame.subBass) || 0;
    out[1] = Number(frame.bass) || 0;
    out[2] = Number(frame.lowMid) || 0;
    out[3] = Number(frame.mid) || 0;
    out[4] = Number(frame.highMid) || 0;
    out[5] = Number(frame.presence) || 0;
    out[6] = Number(frame.brilliance) || 0;
    out[7] = Number(frame.air) || 0;
    return out;
  }
  var bassNow = (typeof bass !== 'undefined' && isFinite(bass)) ? Number(bass) : 0;
  var midNow = (typeof mid !== 'undefined' && isFinite(mid)) ? Number(mid) : 0;
  var trebleNow = (typeof treble !== 'undefined' && isFinite(treble)) ? Number(treble) : 0;
  out[0] = bassNow * 0.9;
  out[1] = bassNow;
  out[2] = midNow * 0.7;
  out[3] = midNow;
  out[4] = midNow * 0.8;
  out[5] = trebleNow * 0.7;
  out[6] = trebleNow;
  out[7] = trebleNow * 0.8;
  return out;
}

// Spectrum where the analyser has data; bands shaped across the 64 bins where it does not, so the
// console still moves on a track that has not been analysed yet.
function mixerFillSpectrum(level, frame, smooth) {
  var k = Math.max(0.06, 1 - Math.min(0.95, Math.max(0, Number(smooth) || 0)) * 0.85);
  var hasFft = typeof frequencyData !== 'undefined' && frequencyData && frequencyData.length > 4;
  var bands = hasFft ? null : mixerBandValues(frame);
  for (var j = 0; j < MIXER_BINS; j++) {
    var target = 0;
    if (hasFft) {
      target = frequencyData[mixerSpectrumIndex(j, MIXER_BINS)] / 255;
    } else if (bands) {
      var t = j / (MIXER_BINS - 1);
      var a = bands[Math.min(7, Math.floor(t * 8))];
      var b = bands[Math.min(7, Math.floor(t * 8) + 1)];
      target = (a + (b - a) * ((t * 8) % 1)) * (1 - t * 0.35);
    }
    var next = level[j] + (target - level[j]) * k;
    level[j] = mixerClamp01(next);
  }
  return level;
}

function mixerWriteSpectrum(data, level) {
  for (var j = 0; j < MIXER_BINS; j++) {
    var off = j * 4;
    data[off] = Math.round(level[j] * 255);
    data[off + 1] = Math.round(level[j] * 255);
    data[off + 2] = Math.round((j / (MIXER_BINS - 1)) * 255);
    data[off + 3] = 255;
  }
}

// ---------------------------------------------------------------- resources

var mixerState = {
  built: false, quadScene: null, quadCam: null, quad: null, mat: null,
  blitScene: null, blitCam: null, blitMat: null,
  rt: null, rtW: 0, rtH: 0, passScale: 0,
  levelData: null, levelTex: null,
  frames: 0, lastCostMs: 0, error: '',
  size: null
};

function mixerInitialUniforms() {
  return {
    iResolution: shadertoyUvUniforms(1, 1),
    iTime: { value: 0 },
    iFrame: { value: 0 },
    iMouse: { value: [0, 0, 0, 0] },
    iChannel0: { value: null },
    uCamPan: { value: 1 },
    uCamAnim: { value: 1 },
    uCamRoll: { value: 1 },
    uCamFov: { value: 4 },
    uGridScale: { value: 1 },
    uLevelGain: { value: 1 },
    uSteps: { value: 100 },
    uShadowSteps: { value: 30 },
    uMaxDist: { value: 50 },
    uBeat: { value: 0 },
    uShakeAmp: { value: 0.6 },
    uShakeRate: { value: 1 },
    uAudioDrive: { value: 1 }
  };
}

function mixerBuildScene() {
  if (mixerState.built) return true;
  if (typeof THREE === 'undefined' || typeof renderer === 'undefined' || !renderer) return false;
  try {
    mixerState.size = new THREE.Vector2(1, 1);
    var levelData = new Uint8Array(MIXER_BINS * 4);
    var levelTex = new THREE.DataTexture(levelData, MIXER_BINS, 1,
      THREE.RGBAFormat, THREE.UnsignedByteType);
    levelTex.magFilter = THREE.LinearFilter;
    levelTex.minFilter = THREE.LinearFilter;
    levelTex.needsUpdate = true;

    var uniforms = mixerInitialUniforms();
    uniforms.iChannel0.value = levelTex;
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.999999, 1.0); }',
      fragmentShader: shadertoyFragment(MIXER_PORT_BODY, { channels: 1 }),
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false
    });
    var quadScene = new THREE.Scene();
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    quadScene.add(quad);

    var blitMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.2 } },
      vertexShader: MIXER_BLIT_VS,
      fragmentShader: MIXER_BLIT_FS,
      depthTest: false,
      depthWrite: false
    });
    var blitScene = new THREE.Scene();
    var blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
    blitQuad.frustumCulled = false;
    blitScene.add(blitQuad);

    mixerState.levelData = levelData;
    mixerState.levelTex = levelTex;
    mixerState.mat = mat;
    mixerState.quadScene = quadScene;
    mixerState.quadCam = quadCam;
    mixerState.quad = quad;
    mixerState.blitMat = blitMat;
    mixerState.blitScene = blitScene;
    mixerState.blitCam = blitCam;
    mixerLevelState.level.fill(0);
    mixerLevelState.peak.fill(0);
    mixerWriteSpectrum(levelData, mixerLevelState.level);
    mixerState.built = true;
    return true;
  } catch (err) {
    mixerState.error = String(err && (err.message || err)).slice(0, 200);
    return false;
  }
}

function mixerAlignPassSize() {
  if (typeof renderer === 'undefined' || !renderer || !mixerState.mat) return false;
  renderer.getDrawingBufferSize(mixerState.size);
  var scale = Math.min(1, Math.max(0.4, mixerParam('renderScale')));
  var w = Math.max(32, Math.round((mixerState.size.x || 1) * scale));
  var h = Math.max(32, Math.round((mixerState.size.y || 1) * scale));
  if (mixerState.rt && mixerState.rtW === w && mixerState.rtH === h && mixerState.passScale === scale) return true;
  if (!mixerState.rt) {
    mixerState.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
  } else {
    mixerState.rt.setSize(w, h);
  }
  mixerState.rtW = w;
  mixerState.rtH = h;
  mixerState.passScale = scale;
  mixerState.mat.uniforms.iResolution.value = shadertoyUvUniforms(w, h).value;
  mixerState.blitMat.uniforms.tDiffuse.value = mixerState.rt.texture;
  return true;
}

// ---------------------------------------------------------------- per-frame

function mixerUpdateLevels(frame, dt, smooth) {
  mixerFillSpectrum(mixerLevelState.level, frame, smooth);
  mixerWriteSpectrum(mixerState.levelData, mixerLevelState.level);
  mixerState.levelTex.needsUpdate = true;
  return true;
}

function mixerFeedUniforms(nowSec) {
  if (!mixerState.mat) return;
  var u = mixerState.mat.uniforms;
  u.uCamPan.value = Math.max(0, mixerParam('camPan'));
  u.uCamAnim.value = Math.max(0, mixerParam('camAnim'));
  u.uCamRoll.value = Math.max(0, mixerParam('camRoll'));
  u.uCamFov.value = Math.max(0.5, mixerParam('camFov'));
  u.uGridScale.value = Math.max(0.1, mixerParam('gridScale'));
  u.uLevelGain.value = Math.max(0, mixerParam('levelGain'));
  u.uSteps.value = Math.max(8, Math.min(160, mixerParam('marchSteps')));
  u.uShadowSteps.value = Math.max(0, Math.min(60, mixerParam('shadowSteps')));
  u.uMaxDist.value = Math.max(5, mixerParam('maxDist'));
  u.uBeat.value = (typeof beatPulse !== 'undefined' && isFinite(beatPulse)) ? Number(beatPulse) : 0;
  u.uShakeAmp.value = Math.max(0, mixerParam('camShake'));
  u.uShakeRate.value = Math.max(0.1, mixerParam('camShakeRate'));
  u.uAudioDrive.value = Math.max(0, mixerParam('audioDrive'));
  mixerState.blitMat.uniforms.uVignette.value = 0.2;
  void nowSec;
}

function updateMixerDeskLayer(now, dt, sonicFrame) {
  if (!mixerPresetIsActive()) return false;
  var startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  if (!mixerState.built && !mixerBuildScene()) return false;
  var step = Math.max(0, Math.min(0.12, Number(dt) || 0));
  mixerUpdateLevels(sonicFrame, step, mixerParam('audioSmooth'));
  mixerFeedUniforms((Number(now) || 0) / 1000);
  mixerState.frames++;
  mixerState.lastCostMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - startedAt;
  return true;
}

function renderMixerDeskFrame() {
  if (!mixerPresetIsActive()) return false;
  if (typeof renderer === 'undefined' || !renderer) return false;
  if (!mixerState.built && !mixerBuildScene()) return false;
  if (!mixerAlignPassSize()) return false;
  // The reference computes its own camera from fragCoord; iTime is the song clock so pausing the
  // music freezes the console.
  var clock = (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) ? Number(audio.currentTime) : 0;
  mixerState.mat.uniforms.iTime.value = clock;
  mixerState.mat.uniforms.iFrame.value = mixerState.frames | 0;
  try {
    renderer.setRenderTarget(mixerState.rt);
    renderer.render(mixerState.quadScene, mixerState.quadCam);
    renderer.setRenderTarget(null);
    renderer.render(mixerState.blitScene, mixerState.blitCam);
  } catch (err) {
    try { renderer.setRenderTarget(null); } catch (ignored) { /* already off-target */ }
    mixerState.error = String((err && (err.message || err)) || err).slice(0, 200);
    return false;
  }
  return true;
}

function mixerDisposeScene() {
  if (mixerState.levelTex) mixerState.levelTex.dispose();
  if (mixerState.mat) mixerState.mat.dispose();
  if (mixerState.blitMat) mixerState.blitMat.dispose();
  if (mixerState.quad && mixerState.quad.geometry) mixerState.quad.geometry.dispose();
  if (mixerState.blitScene && mixerState.blitScene.children[0] && mixerState.blitScene.children[0].geometry) {
    mixerState.blitScene.children[0].geometry.dispose();
  }
  if (mixerState.rt) mixerState.rt.dispose();
  if (mixerState.quadScene) mixerState.quadScene.clear();
  if (mixerState.blitScene) mixerState.blitScene.clear();
  mixerState.built = false;
  mixerState.quadScene = null;
  mixerState.quadCam = null;
  mixerState.quad = null;
  mixerState.mat = null;
  mixerState.blitScene = null;
  mixerState.blitCam = null;
  mixerState.blitMat = null;
  mixerState.rt = null;
  mixerState.rtW = 0;
  mixerState.rtH = 0;
  mixerState.passScale = 0;
  mixerState.levelData = null;
  mixerState.levelTex = null;
  mixerState.frames = 0;
  mixerState.lastCostMs = 0;
  mixerState.error = '';
}

function mixerDeskStatus() {
  return {
    active: mixerPresetIsActive(), built: mixerState.built,
    frames: mixerState.frames, costMs: Math.round(mixerState.lastCostMs * 100) / 100,
    error: mixerState.error,
    passScale: mixerState.passScale, rt: [mixerState.rtW, mixerState.rtH],
    marchSteps: mixerParam('marchSteps'), shadowSteps: mixerParam('shadowSteps')
  };
}

function applyMixerPresetNow(prev, next) {
  var on = Number(next) === MIXER_PRESET_INDEX;
  var was = Number(prev) === MIXER_PRESET_INDEX;
  if (on) {
    mixerBuildScene();
    if (typeof markRenderInteraction === 'function') markRenderInteraction('mixer-preset');
  } else if (was) {
    mixerDisposeScene();
  }
  return on;
}

// The ported console is the whole picture: every layer behind it is taken over, including the
// app's stage lyrics (the reference has no lyric element of its own).
if (typeof registerVisualTakeoverOwner === 'function') {
  registerVisualTakeoverOwner({
    id: 'mixer-desk',
    isActive: mixerPresetIsActive,
    suppresses: {
      particles: true, bloom: true, float: true, backCover: true,
      starRiver: true, ripples: true, lyricsParticles: true, stageLyrics: true
    }
  });
}
