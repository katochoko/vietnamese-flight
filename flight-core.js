/* Pure game rules and progress migration, shared by the page and regression tests. */
(function(root){
  'use strict';
  const DURATION=120, FALL=1.2, FEEDBACK=.72;
  const integer=value=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
  function shuffle(items,random=Math.random){
    const result=[...items];
    for(let i=result.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}
    return result;
  }
  function fresh(){return {version:2,pilot:'plane',audio:false,lastSet:null,words:{},setRuns:{},best:0,flights:0,comboTotal:0};}
  function migrate(raw,sets){
    const state=fresh();
    if(!raw||typeof raw!=='object')return state;
    if(['plane','wizard','bird'].includes(raw.pilot))state.pilot=raw.pilot;
    state.audio=raw.audio===true;
    state.lastSet=sets.some(s=>s.id===raw.lastSet)?raw.lastSet:null;
    state.best=integer(raw.best);state.flights=integer(raw.flights);
    state.comboTotal=raw.version===2?integer(raw.comboTotal):0;
    for(const set of sets){
      for(const word of set.words){
        const saved=raw.words?.[word.id];
        if(!saved||typeof saved!=='object')continue;
        const correct=integer(saved.correct),seen=integer(saved.seen),wrong=integer(saved.wrong);
        // A v1 streak counts distinct games; total correct answers alone do not.
        const successGames=raw.version===2?integer(saved.successGames):Math.max(integer(saved.streak),correct>0?1:0);
        state.words[word.id]={seen,correct,wrong,successGames:Math.min(2,successGames),review:saved.review===true,lastCorrectSession:raw.version===2&&typeof saved.lastCorrectSession==='string'?saved.lastCorrectSession:''};
      }
      const inferred=set.words.some(w=>state.words[w.id]?.seen>0)?1:0;
      state.setRuns[set.id]=Math.max(inferred,raw.version===2?integer(raw.setRuns?.[set.id]):0);
    }
    return state;
  }
  function recordAnswer(state,session,wordId,correct,previousBest){
    const old=state.words[wordId]||{};
    const word={seen:integer(old.seen)+1,correct:integer(old.correct),wrong:integer(old.wrong),successGames:integer(old.successGames),review:old.review===true,lastCorrectSession:old.lastCorrectSession||''};
    if(correct){
      word.correct++;word.review=false;
      if(word.lastCorrectSession!==session.id){word.successGames=Math.min(2,word.successGames+1);word.lastCorrectSession=session.id;}
    }else{word.wrong++;word.review=true;}
    state.words[wordId]=word;
    // Credit only the increase in this game's best streak, so reload/finish cannot double count it.
    state.comboTotal+=Math.max(0,session.bestCombo-previousBest);
  }
  class Session{
    constructor({words,orderedWords=words,reviewOnly=false,mixed=false,random=Math.random,id}){
      if(!words?.length)throw new Error('At least one word is required');
      this.id=id||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
      this.pool=[...words];this.random=random;this.reviewOnly=reviewOnly;this.mixed=mixed;
      this.queue=[...orderedWords];this.phase='first';this.firstAnswered=0;this.secondAnswered=0;
      this.pending=new Set(reviewOnly?words.map(w=>w.id):[]);
      this.answered=new Set();this.mistakes=new Set();this.correct=0;this.wrong=0;
      this.combo=0;this.bestCombo=0;this.altitude=50;this.elapsed=0;this.progress=0;
      this.finished=false;this.paused=false;this.reason=null;this.locked=false;this.feedbackLeft=0;
      this.reviewSlot=0;this.reviewBase=0;this.reviewPeak=0;this.bags={good:[],review:[]};
      this.directions=[];this.serial=0;this.lastWord=null;this.nextQuestion();
    }
    pickReview(kind){
      const candidates=this.pool.filter(w=>kind==='review'?this.pending.has(w.id):!this.pending.has(w.id));
      if(!candidates.length)return null;
      const allowed=new Set(candidates.map(w=>w.id));
      this.bags[kind]=this.bags[kind].filter(w=>allowed.has(w.id));
      if(!this.bags[kind].length)this.bags[kind]=shuffle(candidates,this.random);
      if(this.bags[kind].length>1&&this.bags[kind][0].id===this.lastWord){
        this.bags[kind].push(this.bags[kind].shift());
      }
      return this.bags[kind].shift();
    }
    nextQuestion(){
      if(this.finished)return;
      if(this.phase==='review'){
        if(!this.pending.size){this.end('clear');return;}
        let kind=this.reviewSlot%2===1?'review':'good';this.reviewSlot++;
        this.word=this.pickReview(kind);
        if(!this.word){kind=kind==='good'?'review':'good';this.word=this.pickReview(kind);}
        this.questionKind=kind;
        if(kind==='review'&&this.pending.size===1)this.progress=Math.max(this.progress,.95);
      }else{this.word=this.queue.shift();this.questionKind='round';}
      if(!this.word)throw new Error('Question queue exhausted before completion');
      this.questionPhase=this.phase;
      if(!this.mixed)this.direction='vi-ja';
      else{
        if(!this.directions.length)this.directions=shuffle(['vi-ja','ja-vi'],this.random);
        this.direction=this.directions.shift();
      }
      this.serial++;this.locked=false;this.feedbackLeft=0;
    }
    beginReview(){
      this.phase='review';this.reviewBase=this.progress;this.reviewPeak=this.pending.size;
      this.reviewSlot=0;this.bags={good:[],review:[]};
    }
    answer(correct){
      if(this.finished||this.paused||this.locked)return false;
      this.locked=true;this.feedbackLeft=FEEDBACK;this.lastWord=this.word.id;
      this.answered.add(this.word.id);
      if(correct){
        this.correct++;this.combo++;this.bestCombo=Math.max(this.bestCombo,this.combo);
        this.altitude=Math.min(100,this.altitude+8);this.pending.delete(this.word.id);
      }else{
        this.wrong++;this.combo=0;this.altitude=Math.max(0,this.altitude-18);
        this.pending.add(this.word.id);this.mistakes.add(this.word.id);
      }
      if(this.questionPhase==='first'){
        this.firstAnswered++;
        this.progress=Math.max(this.progress,.5*this.firstAnswered/this.pool.length);
        if(this.firstAnswered===this.pool.length){
          if(this.reviewOnly||this.wrong>0){
            if(!this.pending.size)this.end('clear');else this.beginReview();
          }else{this.phase='second';this.queue=shuffle(this.pool,this.random);}
        }
      }else if(this.questionPhase==='second'){
        this.secondAnswered++;
        this.progress=Math.max(this.progress,.5+.45*this.secondAnswered/this.pool.length);
        if(this.pending.size)this.beginReview();
        else if(this.secondAnswered===this.pool.length)this.end('clear');
      }else{
        this.reviewPeak=Math.max(this.reviewPeak,this.pending.size);
        const completed=this.reviewPeak?1-this.pending.size/this.reviewPeak:1;
        this.progress=Math.min(.95,Math.max(this.progress+.003,this.reviewBase+(.95-this.reviewBase)*completed));
        if(!this.pending.size)this.end('clear');
      }
      if(this.altitude<=0){this.finished=true;this.reason='crash';}
      return true;
    }
    advance(seconds){
      if(this.finished||this.paused||!Number.isFinite(seconds)||seconds<=0)return;
      let left=seconds;
      while(left>1e-9&&!this.finished){
        const available=Math.max(0,DURATION-this.elapsed);
        if(available<=1e-9){this.elapsed=DURATION;this.end('timeout');break;}
        if(this.locked){
          const used=Math.min(left,this.feedbackLeft,available);
          this.elapsed+=used;this.feedbackLeft=Math.max(0,this.feedbackLeft-used);left-=used;
          if(this.elapsed>=DURATION-1e-9){this.elapsed=DURATION;this.end('timeout');}
          else if(this.feedbackLeft<=1e-9)this.nextQuestion();
        }else{
          const used=Math.min(left,available,this.altitude/FALL);
          this.elapsed+=used;this.altitude=Math.max(0,this.altitude-used*FALL);left-=used;
          if(this.altitude<=1e-9){this.altitude=0;this.end('crash');}
          else if(this.elapsed>=DURATION-1e-9){this.elapsed=DURATION;this.end('timeout');}
        }
      }
    }
    end(reason){if(this.finished)return;this.finished=true;this.reason=reason;}
    get x(){return 12+73*this.progress;}
    get phaseLabel(){
      if(this.phase==='first')return `1周目 ${this.firstAnswered} / ${this.pool.length}語`;
      if(this.phase==='second')return `2周目 ${this.secondAnswered} / ${this.pool.length}語`;
      return `復習 残り${this.pending.size}語`;
    }
  }
  root.FlightCore={Session,migrate,recordAnswer,fresh,shuffle,DURATION};
})(typeof window==='undefined'?globalThis:window);
