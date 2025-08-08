import React, { useEffect, useMemo, useRef, useState } from "react";

/*************************************************
 * DREF Flood Boardgame – Single-File React Canvas
 * v6.0 – Full pass with icons, CEA defensive EW, and Role-Change action
 *
 * New in v6.0
 * - **CEA Defensive EW**: EW has charges; CEA places EW with 2 charges.
 *   Each attempted flood into that tile consumes 1 charge (blocks spread).
 *   With **Misinformation** this hazard, EW has a 50% chance to be bypassed.
 * - **Role Change** is now an in-game action:
 *   "Change Role" costs **1 AP**, **-1 morale**, and is limited to **2 uses per game** (team-wide).
 *   Takes effect **immediately**.
 * - **Icons** for mitigation and hazards drawn on canvas with small glyphs + charge badges.
 * - **Action menu** shows costs (Funds + AP) and one-line explanations.
 * - Keeps v5 fixes: AP system, income model, OPS remote limit, pumps reduce upgrades, bridges block, etc.
 *************************************************/

/********************
 * Engine & Models  *
 ********************/
const Roles = { OPS: 'OPS', LOG: 'LOG', CEA: 'CEA', HEALTH: 'HEALTH', SHELTER: 'SHELTER' };
const RoleList = [Roles.OPS, Roles.LOG, Roles.CEA, Roles.HEALTH, Roles.SHELTER];

class Tile {
  constructor(type, x, y) {
    this.type = type; // terrain/state
    this.x = x; this.y = y;
    this.infra = null;         // {kind:'road'|'bridge', damaged:boolean} | null
    this.mitigation = null;    // 'levee' | 'channel' | 'pump' | 'ew' | null
    this.ewCharges = 0;        // for EW blocking
  }
}

class Board {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.grid = Array.from({length:h}, (_,y)=>Array.from({length:w}, (_,x)=>new Tile('lowland', x, y)));
    this.hq = null;
    this.game = null; // backref set by Game
  }
  get(x,y){ if(x<0||y<0||x>=this.width||y>=this.height) return null; return this.grid[y][x]; }
  setType(x,y,type){ const t=this.get(x,y); if(t) t.type=type; }
  neighbors4(x,y){ return [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>this.get(x+dx,y+dy)).filter(Boolean); }
  forEach(cb){ for(let y=0;y<this.height;y++) for(let x=0;x<this.width;x++) cb(this.grid[y][x]); }
}

const rnd = n => Math.floor(Math.random()*n);
const choice = arr => arr[rnd(arr.length)];

function generateRiver(board){
  let y = Math.floor(board.height/2) - 1;
  for(let x=0;x<board.width;x++){
    board.setType(x,y,'river');
    if(Math.random()<0.4){
      const y2 = Math.max(0, Math.min(board.height-1, y + (Math.random()<0.5?-1:1)));
      board.setType(x,y2,'river');
      y = y2;
    }
  }
}

function seedUrban(board){
  for(let i=0;i<Math.floor(board.width/4);i++){
    const x = rnd(board.width-4)+2, y=rnd(board.height-4)+2;
    if(board.get(x,y).type==='lowland'){
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
        const t=board.get(x+dx,y+dy); if(t && t.type==='lowland') t.type='urban';
      }
    }
  }
}

function seedStartFlood(board){
  board.forEach(t=>{
    if(t.type==='river' && Math.random()<0.08){
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const n=board.get(t.x+dx,t.y+dy);
        if(n && n.type!=='river' && n.type!=='urban'){ n.type='flood'; break; }
      }
    }
  });
}

function placeHQ(board){
  for(let tries=0; tries<200; tries++){
    const x=rnd(board.width), y=rnd(board.height); const t=board.get(x,y);
    if(['lowland','urban'].includes(t.type) && !board.neighbors4(x,y).some(n=>n.type==='flood'||n.type==='river')){
      t.type='hq'; board.hq={x,y}; return;
    }
  }
  board.setType(1,1,'hq'); board.hq={x:1,y:1};
}

class FloodAI {
  constructor(board){ this.board=board; this.weather=1; }
  blockedByMitigation(src,dst){ return (src.mitigation==='levee' || dst.mitigation==='levee' || dst.mitigation==='channel'); }
  scoreSpreadTarget(t){ let s=0; const nearRiver=this.board.neighbors4(t.x,t.y).some(n=>n.type==='river'); if(nearRiver) s+=3; if(t.type==='lowland') s+=2; if(t.type==='urban') s+=1; if(t.type==='hq') s+=4; if(t.type==='warehouse'||t.type==='healthpost') s+=2; return s; }
  spread(){
    const g = this.board.game;
    const chance=this.weather===1?1:(this.weather===2?1.2:1.5);
    this.board.forEach(tile=>{
      if(tile.type==='flood'){
        const cands=this.board.neighbors4(tile.x,tile.y).filter(n=>['lowland','urban','highland','hq','warehouse','healthpost'].includes(n.type));
        const scored=cands.map(n=>({t:n,score:this.scoreSpreadTarget(n)})).sort((a,b)=>b.score-a.score);
        if(scored.length){
          const best=scored[0].t;
          if(!this.blockedByMitigation(tile,best)){
            if(Math.random() < Math.min(1,0.8*chance)){
              // EW handling with charges + misinformation nerf
              if(best.mitigation==='ew' && best.ewCharges>0){
                const bypass = g.ewNerf && Math.random()<0.5; // 50% chance to bypass under misinformation
                if(!bypass){ best.ewCharges -= 1; g.log.push(`EW absorbed flood at (${best.x},${best.y})${best.ewCharges?` (charges left: ${best.ewCharges})`:''}`); }
                else { best.type='flood'; g.log.push(`EW bypassed by misinformation at (${best.x},${best.y})`); }
              } else {
                best.type='flood';
              }
            }
          }
        }
      }
    });
  }
  upgrade(){
    this.board.forEach(tile=>{
      if(tile.type!=='flood') return;
      const hazards=this.board.neighbors4(tile.x,tile.y).filter(n=>n.type==='flood'||n.type==='disaster').length;
      const hasMit=this.board.neighbors4(tile.x,tile.y).some(n=>n.mitigation);
      const nearPump=this.board.neighbors4(tile.x,tile.y).some(n=>n.mitigation==='pump');
      if(hazards>=2 && !hasMit && !nearPump) tile.type='disaster';
    });
  }
  damageInfrastructure(){ this.board.forEach(tile=>{ if(tile.infra && !tile.infra.damaged && (tile.type==='flood'||tile.type==='disaster')) tile.infra.damaged=true; }); }
  turn(){ this.spread(); this.upgrade(); this.damageInfrastructure(); }
}

const EventCards = {
  heavyRains: { id:'heavyRains', type:'surge', text:'Heavy Rains: weather +1 and flood river-adjacent lowlands.' },
  leveeBreach: { id:'leveeBreach', type:'surge', text:'Levee Breach: remove one levee and flood that tile.' },
  flashFlood: { id:'flashFlood', type:'surge', text:'Flash Flood: flood a lowland two tiles from river.' },
  accessBlocked: { id:'accessBlocked', type:'challenge', text:'Access Blocked: damage one random road/bridge.' },
  volunteerSurge: { id:'volunteerSurge', type:'aid', text:'Volunteer Surge: +1 action this round.' },
  engineeringTeam: { id:'engineeringTeam', type:'aid', text:'Engineering Team: instantly repair one damaged infra.' },
  donorBoost: { id:'donorBoost', type:'aid', text:'Donor Boost: +3 funds; +1 levee in stock.' },
  misinformation: { id:'misinformation', type:'challenge', text:'Misinformation: morale -1; EW less effective this round.' },
};

class Deck { constructor(cards){ this.drawPile=[...cards]; this.discard=[]; this.shuffle(); } shuffle(){ for(let i=this.drawPile.length-1;i>0;i--){ const j=rnd(i+1); [this.drawPile[i],this.drawPile[j]]=[this.drawPile[j],this.drawPile[i]]; } } draw(){ if(!this.drawPile.length){ this.drawPile=this.discard; this.discard=[]; this.shuffle(); } return this.drawPile.shift(); } discardCard(c){ this.discard.push(c); } }
function defaultDeck(){ const cards=[...Array(4).fill(EventCards.heavyRains), ...Array(3).fill(EventCards.leveeBreach), ...Array(3).fill(EventCards.flashFlood), ...Array(3).fill(EventCards.accessBlocked), ...Array(2).fill(EventCards.volunteerSurge), ...Array(2).fill(EventCards.engineeringTeam), ...Array(2).fill(EventCards.donorBoost), ...Array(2).fill(EventCards.misinformation)].map(c=>({...c})); return new Deck(cards); }

class Player { constructor(name, role){ this.name=name; this.role=role; } }

class Game {
  constructor(w=22, h=14, roles=[Roles.OPS,Roles.LOG,Roles.CEA,Roles.HEALTH,Roles.SHELTER]){
    this.turn=1; this.maxTurns=20; this.players=roles.map((r,i)=>new Player('P'+(i+1), r));
    this.board=new Board(w,h); this.board.game=this; generateRiver(this.board); seedUrban(this.board); seedStartFlood(this.board); placeHQ(this.board);
    this.ai=new FloodAI(this.board); this.deck=defaultDeck();
    this.extraActions=0; this.log=[`Game start: HQ at (${this.board.hq.x},${this.board.hq.y})`];
    this.state={ funds:8, morale:5, stock:{ levee:6, pump:3, channel:3, recovery:5 } };
    this.objectives=[ {id:'protectUrban', text:'Protect 3 river-adjacent urban tiles with levee/channel', done:false}, {id:'restoreRoad', text:'Repair 2 damaged bridges', done:false}, {id:'recoveryPush', text:'Convert 4 flood/disaster to recovery', done:false} ];
    this.lastInfraTurn=0; this.autoplaceInfraEvery=3; this.victory=null; this.lastEvent=null;
    this.ewNerf=false;
    this.opsRemoteUsedTurn=0; // OPS limit
    this.apPerTurn=4; this.ap=this.apPerTurn; // AP system
    this.roleChangesUsed=0; // team-wide limit 2
  }
  passable(t){
    if(!t) return false;
    if(t.type==='flood'||t.type==='disaster') return false;
    if(t.infra && t.infra.kind==='bridge' && t.infra.damaged) return false; // only bridges block
    return true;
  }
  reachable(){
    const vis=new Set(); if(!this.board.hq) return vis; const st=this.board.hq; const key=(x,y)=>`${x},${y}`;
    const q=[key(st.x,st.y)]; vis.add(key(st.x,st.y));
    while(q.length){ const cur=q.shift(); const [cx,cy]=cur.split(',').map(Number);
      for(const n of this.board.neighbors4(cx,cy)) if(this.passable(n)) { const k=key(n.x,n.y); if(!vis.has(k)){ vis.add(k); q.push(k);} }
    }
    return vis;
  }
  isReach(x,y){ return this.reachable().has(`${x},${y}`); }
  autoplaceInfra(){ const cands=[]; this.board.forEach(t=>{ if(!t.infra && ['lowland','urban','recovery','warehouse','healthpost','hq'].includes(t.type)){
      const nearHaz=this.board.neighbors4(t.x,t.y).some(n=>n.type==='flood'||n.type==='river');
      if(nearHaz && t.type!=='flood' && t.type!=='disaster') cands.push(t);
    } });
    if(!cands.length) return; const t=choice(cands); t.infra={kind:Math.random()<0.4?'bridge':'road', damaged:false}; this.log.push(`Infrastructure placed: ${t.infra.kind} at (${t.x},${t.y})`);
  }
  applyEvent(card){ this.lastEvent = card.text; this.log.push(`Event: ${card.text}`);
    switch(card.id){
      case 'heavyRains': this.ai.weather=Math.min(3,this.ai.weather+1); this.board.forEach(t=>{ if(t.type==='lowland' && this.board.neighbors4(t.x,t.y).some(n=>n.type==='river')) t.type='flood'; }); break;
      case 'leveeBreach':{ const levees=[]; this.board.forEach(t=>{ if(t.mitigation==='levee') levees.push(t); }); if(levees.length){ const t=choice(levees); t.mitigation=null; t.type='flood'; this.log.push(`Levee breached at (${t.x},${t.y})`);} break; }
      case 'flashFlood':{ const far=[]; this.board.forEach(t=>{ if(t.type==='lowland'){ const near=[[2,0],[-2,0],[0,2],[0,-2]].map(([dx,dy])=>this.board.get(t.x+dx,t.y+dy)).filter(Boolean).some(n=>n.type==='river'); if(near) far.push(t); } }); if(far.length){ const t=choice(far); t.type='flood'; } break; }
      case 'accessBlocked':{ const roads=[]; this.board.forEach(t=>{ if(t.infra && !t.infra.damaged) roads.push(t); }); if(roads.length){ const t=choice(roads); t.infra.damaged=true; this.log.push(`Access blocked at (${t.x},${t.y})`);} break; }
      case 'volunteerSurge': this.extraActions+=1; this.log.push('+1 AP this round'); break;
      case 'engineeringTeam':{ const damaged=[]; this.board.forEach(t=>{ if(t.infra && t.infra.damaged) damaged.push(t); }); if(damaged.length){ const t=choice(damaged); t.infra.damaged=false; this.log.push(`Engineering team repaired infra at (${t.x},${t.y})`);} break; }
      case 'donorBoost': this.state.funds+=3; this.state.stock.levee+=1; break;
      case 'misinformation': this.state.morale=Math.max(0,this.state.morale-1); this.ewNerf=true; break;
      default: break;
    }
  }
  canAfford(c){ return this.state.funds>=c; }
  pay(c){ this.state.funds-=c; }
  consumeAP(){ if(this.ap<=0) return false; this.ap-=1; return true; }
  placeMitigation(x,y,kind,actor){
    const t=this.board.get(x,y); if(!t) return false;
    const inReach=this.isReach(x,y);
    const wantsRemote = (actor?.role===Roles.OPS && kind!=='pump' && !inReach);
    if(!inReach && !wantsRemote) return false;
    if(wantsRemote && this.opsRemoteUsedTurn===this.turn) return false;
    const stockKey= kind==='ew'? null : kind; const cost = kind==='levee'?1 : kind==='channel'?2 : kind==='pump'?2 : 0;
    if(stockKey && this.state.stock[stockKey]<=0) return false; if(!this.canAfford(cost)) return false; if(this.ap<=0) return false;
    if(t.mitigation) return false;
    if(!this.consumeAP()) return false;
    t.mitigation=kind; if(kind==='ew'){ t.ewCharges = (actor?.role===Roles.CEA)? 2 : 1; } if(stockKey) this.state.stock[stockKey]--; if(cost) this.pay(cost);
    if(wantsRemote) this.opsRemoteUsedTurn=this.turn;
    this.log.push(`${actor?.role||'Player'} placed ${kind}${kind==='ew'?` (EW charges: ${t.ewCharges})`:''} at (${x},${y})`);
    return true;
  }
  placeRecovery(x,y,actor){
    const t=this.board.get(x,y); if(!t) return false; if(!this.isReach(x,y)) return false; if(!(t.type==='disaster'||t.type==='flood')) return false; if(this.ap<=0) return false;
    let cost=2; const isUrban = (t.type==='flood' || t.type==='disaster') && this.board.get(x,y) && this.board.get(x,y).type; // type check kept simple
    if(actor?.role===Roles.HEALTH){
      // If this tile is originally urban now flooded, we can't track origin; discount urban neighbors
      const nearUrban = this.board.neighbors4(x,y).some(n=>n.type==='urban' || n.type==='hq');
      if(nearUrban) cost=1;
    }
    if(this.state.stock.recovery<=0 || !this.canAfford(cost)) return false;
    if(!this.consumeAP()) return false;
    t.type='recovery'; t.mitigation=null; t.ewCharges=0; this.state.stock.recovery--; this.pay(cost); if(actor?.role===Roles.SHELTER) this.state.morale+=1;
    this.log.push(`${actor?.role||'Player'} recovered (${x},${y})`);
    return true;
  }
  buildPreparedness(x,y,kind,actor){ const t=this.board.get(x,y); if(!t || !this.isReach(x,y)) return false; if(this.ap<=0) return false; const cost=2; if(!this.canAfford(cost)) return false; if(['lowland','urban','recovery'].includes(t.type) && !t.infra && !['warehouse','healthpost'].includes(t.type)){ if(!this.consumeAP()) return false; t.type=kind; this.pay(cost); this.log.push(`${actor?.role||'Player'} built ${kind} at (${x},${y})`); return true; } return false; }
  repairInfra(x,y,actor){ const t=this.board.get(x,y); if(!t||!t.infra||!t.infra.damaged) return false; if(!this.isReach(x,y)) return false; if(this.ap<=0) return false; const cost = (actor?.role===Roles.LOG)?1:2; if(!this.canAfford(cost)) return false; if(!this.consumeAP()) return false; this.pay(cost); t.infra.damaged=false; this.log.push(`${actor?.role||'Player'} repaired ${t.infra.kind} at (${x},${y})`); return true; }
  changeRole(playerIndex, newRole){
    if(this.roleChangesUsed>=2) return false;
    if(this.ap<=0) return false;
    const p=this.players[playerIndex]; if(!p) return false; if(p.role===newRole) return false;
    if(!this.consumeAP()) return false;
    p.role=newRole; this.state.morale=Math.max(0,this.state.morale-1); this.roleChangesUsed+=1;
    this.log.push(`Role changed: P${playerIndex+1} → ${newRole} (–1 morale)`);
    return true;
  }
  computeScore(){ let recovery=0, disaster=0; this.board.forEach(t=>{ if(t.type==='recovery') recovery++; if(t.type==='disaster') disaster++; }); return {recovery,disaster}; }
  checkObjectives(){
    if(!this.objectives[0].done){ let c=0; this.board.forEach(t=>{ if(t.type==='urban' && this.board.neighbors4(t.x,t.y).some(n=>n.type==='river') && (t.mitigation==='levee' || t.mitigation==='channel')) c++; }); if(c>=3){ this.objectives[0].done=true; this.state.funds+=2; this.state.morale+=1; this.log.push('Objective complete: Protect Urban'); } }
    if(!this.objectives[1].done){ let repaired=0; this.board.forEach(t=>{ if(t.infra && t.infra.kind==='bridge' && !t.infra.damaged) repaired++; }); if(repaired>=2){ this.objectives[1].done=true; this.state.funds+=1; this.state.morale+=1; this.log.push('Objective complete: Restore Bridges'); } }
    if(!this.objectives[2].done){ let rec=0; this.board.forEach(t=>{ if(t.type==='recovery') rec++; }); if(rec>=4){ this.objectives[2].done=true; this.state.funds+=2; this.log.push('Objective complete: Recovery Push'); } }
  }
  checkEnd(){
    const {recovery,disaster}=this.computeScore(); const total=this.board.width*this.board.height; const hq=this.board?.hq ? this.board.get(this.board.hq.x,this.board.hq.y) : null;
    if(hq && (hq.type==='flood'||hq.type==='disaster')) { this.victory='loss'; return true; }
    if(this.state.morale<=0||this.state.funds<0){ this.victory='loss'; return true; }
    if(disaster/total>=0.5){ this.victory='loss'; return true; }
    if(this.turn>=12 && disaster <= Math.floor(0.1*total)) { this.victory='win'; return true; }
    if(this.turn>this.maxTurns && recovery>=disaster){ this.victory='win'; return true; }
    return false;
  }
  startPlayerPhase(){
    const baseIncome=2; let rec=0; this.board.forEach(t=>{ if(t.type==='recovery') rec++; }); const recoveryIncome=Math.floor(rec/2);
    const inc=baseIncome+recoveryIncome; this.state.funds+=inc; this.ap=this.apPerTurn + this.extraActions; this.extraActions=0;
    this.opsRemoteUsedTurn=0; this.ewNerf=false;
    this.log.push(`Start of Turn ${this.turn}: +$${baseIncome}${recoveryIncome?` +$${recoveryIncome} (recovery)`:''}, AP=${this.ap}`);
  }
  hazardPhase(){
    const card=this.deck.draw(); this.applyEvent(card); this.deck.discardCard(card);
    this.ai.turn();
    if(this.turn - this.lastInfraTurn >= this.autoplaceInfraEvery){ this.autoplaceInfra(); this.lastInfraTurn=this.turn; }
    const end=this.checkEnd(); return {end};
  }
  endPlayerPhase(){ this.checkObjectives(); const end=this.checkEnd(); this.turn++; if(this.ai.weather>1) this.ai.weather-=1; return {end}; }
  act(action, actor, x, y, extra){
    switch(action){
      case 'levee': case 'channel': case 'pump': case 'ew': return this.placeMitigation(x,y,action,actor);
      case 'recovery': return this.placeRecovery(x,y,actor);
      case 'repair': return this.repairInfra(x,y,actor);
      case 'warehouse': case 'healthpost': return this.buildPreparedness(x,y,action,actor);
      case 'changeRole': return this.changeRole(extra.playerIndex, extra.newRole);
      default: return false;
    }
  }
}

/********************
 * UI: Canvas & Draw *
 ********************/
const TILE_SIZE=28;
const COLORS={ lowland:'#89c57e', river:'#2f7fd3', urban:'#b6b6b6', highland:'#a3b57a', hq:'#fff7a3', flood:'#2a5faf', disaster:'#23406b', recovery:'#9bd1ff', warehouse:'#ffe0a6', healthpost:'#ffd4d4' };

function drawIcon(ctx, x, y, kind, data){
  const cx=x+TILE_SIZE/2, cy=y+TILE_SIZE/2;
  ctx.save();
  switch(kind){
    case 'levee': // small brown wall
      ctx.fillStyle = '#b09d7c';
      ctx.fillRect(x+6,y+12,TILE_SIZE-12,6);
      break;
    case 'channel': // blue diagonal
      ctx.strokeStyle = '#6ec0ff'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(x+5,y+5); ctx.lineTo(x+TILE_SIZE-5,y+TILE_SIZE-5); ctx.stroke();
      break;
    case 'pump': // dark square + circle
      ctx.fillStyle='#333'; ctx.fillRect(cx-7,cy-7,14,14);
      ctx.strokeStyle='#ddd'; ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2); ctx.stroke();
      break;
    case 'ew': // tower + charge badge
      ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(cx, y+6); ctx.lineTo(cx, y+TILE_SIZE-6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, y+12); ctx.lineTo(cx-6, y+20); ctx.moveTo(cx, y+12); ctx.lineTo(cx+6, y+20); ctx.stroke();
      if(data?.charges){
        ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(x+TILE_SIZE-14,y+2,12,10);
        ctx.fillStyle='#fff'; ctx.font='10px sans-serif'; ctx.fillText(String(data.charges), x+TILE_SIZE-10, y+10);
      }
      break;
    case 'floodWaves': // waves
      ctx.strokeStyle='#cfe7ff'; ctx.lineWidth=2;
      for(let i=0;i<3;i++){ const yy=y+8+i*6; ctx.beginPath(); ctx.arc(cx-6,yy,6,0,Math.PI); ctx.stroke(); }
      break;
    case 'disasterMark': // burst
      ctx.strokeStyle='#ffcc66'; ctx.lineWidth=2; for(let i=0;i<6;i++){ const ang=i*Math.PI/3; ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+10*Math.cos(ang), cy+10*Math.sin(ang)); ctx.stroke(); }
      break;
    case 'recoveryFlag': // flag
      ctx.strokeStyle='#004'; ctx.beginPath(); ctx.moveTo(x+6,y+20); ctx.lineTo(x+6,y+6); ctx.stroke();
      ctx.fillStyle='#9bd1ff'; ctx.beginPath(); ctx.moveTo(x+6,y+6); ctx.lineTo(x+16,y+10); ctx.lineTo(x+6,y+14); ctx.closePath(); ctx.fill();
      break;
  }
  ctx.restore();
}

function drawBoard(ctx, game, reachable, validSet, hoverKey){
  const b=game.board; ctx.clearRect(0,0,b.width*TILE_SIZE,b.height*TILE_SIZE);
  b.forEach(t=>{
    const px=t.x*TILE_SIZE, py=t.y*TILE_SIZE;
    ctx.fillStyle = COLORS[t.type] || '#7fb56e';
    ctx.fillRect(px,py,TILE_SIZE-1,TILE_SIZE-1);

    // hazard icons
    if(t.type==='flood') drawIcon(ctx, px, py, 'floodWaves');
    if(t.type==='disaster') drawIcon(ctx, px, py, 'disasterMark');
    if(t.type==='recovery') drawIcon(ctx, px, py, 'recoveryFlag');

    // Infrastructure
    if(t.infra){ ctx.strokeStyle = t.infra.damaged?'#ff5555':'#222'; ctx.lineWidth=2; if(t.infra.kind==='road'){ ctx.beginPath(); ctx.moveTo(px+2,py+TILE_SIZE/2); ctx.lineTo(px+TILE_SIZE-4,py+TILE_SIZE/2); ctx.stroke(); } else { ctx.beginPath(); ctx.moveTo(px+TILE_SIZE/2,py+2); ctx.lineTo(px+TILE_SIZE/2,py+TILE_SIZE-4); ctx.stroke(); } }

    // Mitigation icons
    if(t.mitigation){ drawIcon(ctx, px, py, t.mitigation, {charges:t.ewCharges}); }

    // HQ outline
    if(t.type==='hq'){ ctx.strokeStyle='#000'; ctx.strokeRect(px+4,py+4,TILE_SIZE-9,TILE_SIZE-9); }

    // Reach overlay (soft)
    if(reachable.has(`${t.x},${t.y}`)){ ctx.strokeStyle='rgba(255,255,255,0.18)'; ctx.strokeRect(px+1,py+1,TILE_SIZE-3,TILE_SIZE-3); }

    // Valid target highlight
    if(validSet && validSet.has(`${t.x},${t.y}`)){ ctx.strokeStyle='rgba(255,255,0,0.9)'; ctx.lineWidth=2; ctx.strokeRect(px+2,py+2,TILE_SIZE-5,TILE_SIZE-5); }

    // Hover
    if(hoverKey === `${t.x},${t.y}`){ ctx.strokeStyle='rgba(255,255,255,0.95)'; ctx.lineWidth=2; ctx.strokeRect(px+1,py+1,TILE_SIZE-3,TILE_SIZE-3); }
  });
}

/********************
 * UI: Helpers
 ********************/
function LegendSwatch({color,label}){ return (<div className="flex items-center gap-2 text-[11px]"><span className="inline-block w-4 h-3 rounded" style={{backgroundColor:color}}></span>{label}</div>); }

function roleInfo(role){
  return {
    [Roles.OPS]: "OPS: One mitigation per turn can ignore reach (not pumps).",
    [Roles.LOG]: "LOG: Repairs bridges/roads for $1 instead of $2.",
    [Roles.CEA]: "CEA: Early Warning blocks two waves (2 charges).",
    [Roles.HEALTH]: "HEALTH: Recovery near urban costs $1 (vs $2).",
    [Roles.SHELTER]: "SHELTER: +1 morale when you place Recovery.",
  }[role] || '';
}

function actionInfo(action){
  return {
    levee: "Levee — $1, 1 AP: Blocks flood entering this tile.",
    channel: "Channel — $2, 1 AP: Diverts water; slows spread.",
    pump: "Pump — $2, 1 AP: Reduces nearby upgrades to Disaster.",
    ew: "Early Warning — $0, 1 AP: Blocks 1 wave (2 if placed by CEA).",
    recovery: "Recovery — $2 (or $1 with HEALTH near urban), 1 AP: Convert Flood/Disaster to Recovery.",
    repair: "Repair — $2 (or $1 with LOG), 1 AP: Fix damaged bridge/road.",
    warehouse: "Warehouse — $2, 1 AP: Preparedness building (future bonuses).",
    healthpost: "Health Post — $2, 1 AP: Preparedness building (future bonuses).",
    changeRole: "Change Role — 1 AP, -1 morale: Swap one player role (max 2 per game).",
  }[action] || '';
}

function canActAt(game, action, actor, x, y){
  if(action==='changeRole'){
    if(game.roleChangesUsed>=2) return [false,'No role changes left'];
    if(game.ap<=0) return [false,'No AP left'];
    return [true,''];
  }
  const t = game.board.get(x,y); if(!t) return [false,'Out of bounds'];
  const reachable = game.isReach(x,y);
  const wantsRemote = (actor?.role===Roles.OPS && action!=='pump' && !reachable);
  if(!reachable && !wantsRemote) return [false,'Not reachable from HQ'];
  if(action==='recovery'){
    if(!(t.type==='disaster'||t.type==='flood')) return [false,'Target must be Flood/Disaster'];
    const nearUrban = game.board.neighbors4(x,y).some(n=>n.type==='urban'||n.type==='hq');
    const cost = (actor?.role===Roles.HEALTH && nearUrban)?1:2; if(game.state.funds<cost) return [false,'Insufficient funds'];
    if(game.state.stock.recovery<=0) return [false,'No recovery kits'];
    if(game.ap<=0) return [false,'No AP left'];
    return [true,''];
  }
  if(action==='repair'){
    if(!(t.infra && t.infra.damaged)) return [false,'No damaged infra here'];
    const cost = (actor?.role===Roles.LOG)?1:2; if(game.state.funds<cost) return [false,'Insufficient funds'];
    if(game.ap<=0) return [false,'No AP left'];
    return [true,''];
  }
  if(action==='warehouse' || action==='healthpost'){
    if(!['lowland','urban','recovery'].includes(t.type)) return [false,'Build on safe/urban/recovery'];
    if(t.infra) return [false,'Tile already has infra'];
    if(game.state.funds<2) return [false,'Insufficient funds'];
    if(game.ap<=0) return [false,'No AP left'];
    return [true,''];
  }
  if(['levee','channel','pump','ew'].includes(action)){
    if(t.mitigation) return [false,'Mitigation already present'];
    const cost = action==='levee'?1: action==='channel'?2: action==='pump'?2: 0;
    const stockKey = action==='ew'? null : action;
    if(stockKey && game.state.stock[stockKey]<=0) return [false,`No ${action} stock`];
    if(game.state.funds<cost) return [false,'Insufficient funds'];
    if(game.ap<=0) return [false,'No AP left'];
    return [true,''];
  }
  return [false,'Invalid action'];
}

/********************
 * UI: Main Component
 ********************/
function App(){
  const [game, setGame] = useState(()=> new Game(22,14));
  const [actorIndex, setActorIndex] = useState(0);
  const [action, setAction] = useState('levee');
  const [message, setMessage] = useState('Select a role & action, then click a yellow tile.');
  const [hoverKey, setHoverKey] = useState(null);
  const [tick, setTick] = useState(0);
  const [showReach, setShowReach] = useState(true);
  const [roleChangeTarget, setRoleChangeTarget] = useState(Roles.OPS);

  const canvasRef = useRef(null);
  const actor = game.players[actorIndex];

  // Start-of-turn income/AP on mount
  useEffect(()=>{ game.startPlayerPhase(); setTick(t=>t+1); /* eslint-disable-next-line */}, []);

  const reachable = useMemo(()=> game.reachable(), [game, tick, game.state.funds, game.state.morale]);
  const validSet = useMemo(()=>{ if(action==='changeRole') return null; const set=new Set(); for(let y=0;y<game.board.height;y++) for(let x=0;x<game.board.width;x++){ const [ok]=canActAt(game, action, actor, x, y); if(ok) set.add(`${x},${y}`); } return set; }, [game, action, actor, tick]);

  useEffect(()=>{ const c=canvasRef.current; if(!c) return; const ctx=c.getContext('2d'); if(!ctx) return; try { drawBoard(ctx, game, showReach?reachable:new Set(), validSet||new Set(), hoverKey); } catch(e){ console.error('Draw error', e); } }, [game, reachable, validSet, hoverKey, showReach, tick]);

  const onCanvasClick=(e)=>{
    if(action==='changeRole') return; // role change is handled by button
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor((e.clientX-rect.left)/TILE_SIZE); const y=Math.floor((e.clientY-rect.top)/TILE_SIZE);
    const [ok, reason] = canActAt(game, action, actor, x, y);
    if(!ok){ setMessage(`Blocked: ${reason}`); return; }
    const placed = game.act(action, actor, x, y);
    if(placed){ setMessage(`${actor.role} → ${action} at (${x},${y}). AP left: ${game.ap}`); setTick(t=>t+1); }
    else setMessage('Action failed.');
  };

  const onEndTurn=()=>{
    const {end: endA} = game.endPlayerPhase();
    const {end: endB} = game.hazardPhase();
    if(game.victory){ setTick(t=>t+1); alert(`Game Over: ${game.victory}`); return; }
    game.startPlayerPhase();
    setTick(t=>t+1);
  };

  const onReset=()=>{ const fresh=new Game(22,14); setGame(fresh); setTick(t=>t+1); setMessage('New game.'); setTimeout(()=>{ fresh.startPlayerPhase(); setTick(t=>t+1); }, 0); };

  const doChangeRole=()=>{
    const [ok, reason] = canActAt(game, 'changeRole', actor, 0, 0);
    if(!ok){ setMessage(`Blocked: ${reason}`); return; }
    const success = game.act('changeRole', actor, 0, 0, {playerIndex: actorIndex, newRole: roleChangeTarget});
    if(success){ setMessage(`Role changed to ${roleChangeTarget}. AP left: ${game.ap}`); setTick(t=>t+1); }
    else setMessage('Role change failed.');
  };

  const {recovery, disaster} = game.computeScore();
  const inspector = useMemo(()=>{ if(!hoverKey) return null; const [x,y]=hoverKey.split(',').map(Number); const t=game.board.get(x,y); if(!t) return null; const reach = game.isReach(x,y); const nearRiver = game.board.neighbors4(x,y).some(n=>n.type==='river'); return {x,y, type:t.type, reach, mitigation:t.mitigation||'—', infra: t.infra?`${t.infra.kind}${t.infra.damaged?' (damaged)':''}`:'—', nearRiver, ewCharges:t.ewCharges}; }, [hoverKey, game, tick]);

  return (
    <div className="w-full h-full bg-slate-900 text-slate-100 flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold">DREF Flood Boardgame</h1>
          <div className="text-xs opacity-80">Act → End Turn (Hazard auto) → Income & AP reset</div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1"><input type="checkbox" checked={showReach} onChange={e=>setShowReach(e.target.checked)} /> Show reach</label>
          <button onClick={onReset} className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700">Reset</button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-8">
          <div className="rounded-2xl overflow-hidden shadow-xl border border-slate-800">
            <canvas ref={canvasRef} width={game.board.width*TILE_SIZE} height={game.board.height*TILE_SIZE}
              onClick={onCanvasClick}
              onMouseMove={(e)=>{ const r=e.currentTarget.getBoundingClientRect(); const x=Math.floor((e.clientX-r.left)/TILE_SIZE); const y=Math.floor((e.clientY-r.top)/TILE_SIZE); setHoverKey(`${x},${y}`); }}
              className="bg-black" />
          </div>
          <div className="mt-2 text-xs text-slate-300 min-h-5">{message}</div>
        </div>

        <div className="col-span-4 space-y-3">
          {/* Role & Action */}
          <div className="p-3 rounded-xl border border-slate-800 bg-slate-800/40">
            <div className="text-sm font-semibold mb-2">Role & Action</div>
            <div className="flex gap-2 mb-2">
              <select value={actorIndex} onChange={e=>setActorIndex(Number(e.target.value))} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs w-1/2">
                {game.players.map((p,i)=>(<option key={i} value={i}>{p.name} – {p.role}</option>))}
              </select>
              <select value={action} onChange={e=>setAction(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs w-1/2">
                <option value="levee">Levee ($1, 1AP)</option>
                <option value="channel">Channel ($2, 1AP)</option>
                <option value="pump">Pump ($2, 1AP)</option>
                <option value="ew">Early Warning ($0, 1AP)</option>
                <option value="recovery">Recovery ($2/1, 1AP)</option>
                <option value="repair">Repair ($2/1, 1AP)</option>
                <option value="warehouse">Warehouse ($2, 1AP)</option>
                <option value="healthpost">Health Post ($2, 1AP)</option>
                <option value="changeRole">Change Role (1AP, -1 morale)</option>
              </select>
            </div>
            <div className="text-[11px] grid grid-cols-2 gap-2">
              <div className="opacity-90">{roleInfo(game.players[actorIndex].role)}</div>
              <div className="opacity-90">{actionInfo(action)}</div>
            </div>

            {action==='changeRole' && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span>New role:</span>
                <select value={roleChangeTarget} onChange={e=>setRoleChangeTarget(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1">
                  {RoleList.map(r=> (<option key={r} value={r}>{r}</option>))}
                </select>
                <button onClick={doChangeRole} className="px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-600">Apply</button>
                <span className="opacity-70">Remaining uses: {2 - game.roleChangesUsed}</span>
              </div>
            )}

            <div className="flex gap-2 mt-2">
              <button onClick={onEndTurn} className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs">End Turn (Hazard auto)</button>
            </div>
          </div>

          {/* Status */}
          <div className="p-3 rounded-xl border border-slate-800 bg-slate-800/40 text-xs">
            <div className="font-semibold mb-2">Status</div>
            <div>Turn: {game.turn}/{game.maxTurns} · Weather: {game.ai.weather} {game.lastEvent?`· Last Event: ${game.lastEvent}`:''}</div>
            <div className="text-sm mt-1">Funds: <span className="font-semibold">${game.state.funds}</span> · Morale: <span className="font-semibold">{game.state.morale}</span> · AP: <span className="font-semibold">{game.ap}/{game.apPerTurn}</span> · Role changes left: {2 - game.roleChangesUsed}</div>
            <div>Stock → Levee: {game.state.stock.levee} · Channel: {game.state.stock.channel} · Pump: {game.state.stock.pump} · Recovery: {game.state.stock.recovery}</div>
            <div>Score → Recovery: {recovery} · Disaster: {disaster}</div>
            <div className="mt-1 text-[11px] opacity-80">Yellow = legal tiles. OPS may place 1 mitigation out-of-reach per turn (not pumps). CEA EW shows charges badge.</div>
          </div>

          {/* Inspector */}
          <div className="p-3 rounded-xl border border-slate-800 bg-slate-800/40 text-xs min-h-24">
            <div className="font-semibold mb-2">Tile Inspector</div>
            {inspector ? (
              <div className="grid grid-cols-2 gap-y-1">
                <div>Coord:</div><div>({inspector.x},{inspector.y})</div>
                <div>Type:</div><div>{inspector.type}</div>
                <div>Reachable:</div><div>{inspector.reach? 'Yes':'No'}</div>
                <div>Mitigation:</div><div>{inspector.mitigation}{inspector.mitigation==='ew' && inspector.ewCharges?` (${inspector.ewCharges} charges)`:''}</div>
                <div>Infrastructure:</div><div>{inspector.infra}</div>
                <div>Near River:</div><div>{inspector.nearRiver? 'Yes':'No'}</div>
              </div>
            ) : (<div className="opacity-70">Hover the board to inspect a tile.</div>)}
          </div>

          {/* Legend */}
          <div className="p-3 rounded-xl border border-slate-800 bg-slate-800/40 text-xs">
            <div className="font-semibold mb-2">Legend</div>
            <div className="grid grid-cols-2 gap-y-1">
              <LegendSwatch color={COLORS.river} label="River"/>
              <LegendSwatch color={COLORS.lowland} label="Lowland"/>
              <LegendSwatch color={COLORS.urban} label="Urban"/>
              <LegendSwatch color={COLORS.flood} label="Flood (waves)"/>
              <LegendSwatch color={COLORS.disaster} label="Disaster (burst)"/>
              <LegendSwatch color={COLORS.recovery} label="Recovery (flag)"/>
              <LegendSwatch color={COLORS.hq} label="HQ"/>
              <LegendSwatch color="#b09d7c" label="Levee icon"/>
            </div>
          </div>

          {/* Log */}
          <div className="p-3 rounded-xl border border-slate-800 bg-slate-800/40 text-xs max-h-60 overflow-auto">
            <div className="font-semibold mb-2">Log</div>
            <ul className="space-y-1">{game.log.slice().reverse().map((l,i)=>(<li key={i} className="opacity-80">{l}</li>))}</ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
