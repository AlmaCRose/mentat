'use strict';
// Your own status: bars, cooldowns, travel, refills and unread notifications.
// One v1 request per interval (default 60s). Timers are kept as absolute end times, so the
// UI counts down and desktop alerts fire locally without any extra requests.

const { EventEmitter } = require('events');

const FULL = '/user/?selections=basic,bars,cooldowns,travel,refills,notifications,timestamp';
const BASIC = '/user/?selections=basic,timestamp';
const LIMITED_RETRY_MS = 3600 * 1000;
const ARM_MS = 5000;

class UserFeature extends EventEmitter {
  constructor({ api, store, notify }) {
    super();
    this.api = api;
    this.store = store;
    this.notify = notify;
    this.inFlight = false;
    this.lastAttempt = 0;
    this.limitedAt = 0;
    this.edges = {};
    this.state = { data: null, limited: false, fetchedAt: 0, error: '' };
    api.on('key', () => this.reset());
  }

  reset() {
    this.state = { data: null, limited: false, fetchedAt: 0, error: '' };
    this.edges = {};
    this.lastAttempt = 0;
    this.limitedAt = 0;
    this.emit('state');
  }

  snapshot() {
    return this.state;
  }

  meId() {
    return this.state.data ? this.state.data.me.id : (this.store.get('api.account') || {}).id || 0;
  }

  refresh() {
    this.lastAttempt = 0;
  }

  tick(now) {
    if (!this.api.hasKey()) return;
    this.checkAlerts(now);
    const every = Math.max(30, Number(this.store.get('user.interval')) || 60) * 1000;
    if (this.inFlight || now - this.lastAttempt < every) return;
    this.fetch(now);
  }

  async fetch(now) {
    this.inFlight = true;
    this.lastAttempt = now;
    const limited = this.limitedAt && now - this.limitedAt < LIMITED_RETRY_MS;
    try {
      const data = await this.api.request(limited ? BASIC : FULL, { soft: [16], priority: 3 });
      this.apply(data, !!limited);
    } catch (e) {
      if (e.kind === 'soft' && e.code === 16) {
        // Public key: only basic info is allowed. Try again with that straight away.
        this.limitedAt = now;
        this.lastAttempt = 0;
      } else if (e.kind !== 'paused' && e.kind !== 'nokey') {
        this.state.error = e.message;
        this.emit('state');
      }
    } finally {
      this.inFlight = false;
    }
  }

  apply(d, limited) {
    // Torn's clock and this PC's clock differ by a second or so. Timers come back as "seconds
    // left", so anchor them to the local time the response arrived; absolute server times
    // (status.until) are shifted by the measured offset. Otherwise a cooldown that is already
    // over can look like it ends a moment from now and then "end" on the next tick.
    const at = Date.now();
    const skew = d.timestamp ? d.timestamp * 1000 - at : 0;
    const local = t => (t ? t * 1000 - skew : 0);
    const bar = b => b && {
      current: b.current || 0,
      maximum: b.maximum || 0,
      tickAt: at + (b.ticktime || 0) * 1000,
      fullAt: at + (b.fulltime || 0) * 1000,
      increment: b.increment || 0, // per tick (the Planner projects bars with these)
      interval: b.interval || 0,   // seconds between ticks
    };
    const s = d.status || {};
    const cd = d.cooldowns || {};
    const tr = d.travel;
    const rf = d.refills;
    const n = d.notifications;
    const prev = this.state.data;

    // Measure real flight times for the travel planner (outbound flights only: on the way
    // home the API says "Torn" and not where you flew from).
    if (tr && tr.destination && tr.destination !== 'Torn' && tr.departed && tr.timestamp > tr.departed && tr.method) {
      const key = `${tr.departed}`;
      if (key !== this.lastFlightKey) {
        this.lastFlightKey = key;
        this.emit('flight', { destination: tr.destination, method: tr.method, minutes: (tr.timestamp - tr.departed) / 60 });
      }
    }

    this.state = {
      limited,
      fetchedAt: Date.now(),
      error: '',
      data: {
        me: { id: d.player_id || 0, name: d.name || '', level: d.level || 0 },
        status: { state: s.state || '', description: s.description || '', details: s.details || '', color: s.color || '', until: local(s.until) },
        bars: limited ? null : { energy: bar(d.energy), nerve: bar(d.nerve), happy: bar(d.happy), life: bar(d.life) },
        cooldowns: limited ? null : { drug: at + (cd.drug || 0) * 1000, booster: at + (cd.booster || 0) * 1000, medical: at + (cd.medical || 0) * 1000 },
        travel: tr && tr.destination ? { destination: tr.destination, method: tr.method || '', arriveAt: at + (tr.time_left || 0) * 1000, departedAt: local(tr.departed), departed: tr.departed || 0 } : null,
        refills: rf ? { energy: !!rf.energy_refill_used, nerve: !!rf.nerve_refill_used, token: !!rf.token_refill_used } : null,
        notifications: n ? { messages: n.messages || 0, events: n.events || 0, awards: n.awards || 0 } : null,
      },
    };

    // New events/messages since the last check.
    const on = this.store.get('user.notify') || {};
    const pn = prev && prev.notifications;
    const nn = this.state.data.notifications;
    if (pn && nn) {
      if (on.events && nn.events > pn.events) this.notify('Torn: new events', `${nn.events} unread event${nn.events === 1 ? '' : 's'}`, 'https://www.torn.com/events.php', 'events');
      if (on.messages && nn.messages > pn.messages) this.notify('Torn: new messages', `${nn.messages} unread message${nn.messages === 1 ? '' : 's'}`, 'https://www.torn.com/messages.php', 'messages');
    }
    this.checkAlerts(Date.now());
    this.emit('state');
  }

  // Fires once when a timer runs out, and only for a timer that was seen actually counting
  // down (more than ARM_MS left). Timers that are already over, or within a moment of it,
  // when the app starts never alert.
  timer(name, endAt, now, fire) {
    if (endAt > now) {
      if (endAt - now > ARM_MS) this.edges[name] = true;
      return;
    }
    if (this.edges[name]) {
      this.edges[name] = false;
      fire();
    }
  }

  checkAlerts(now) {
    const d = this.state.data;
    if (!d) return;
    const on = this.store.get('user.notify') || {};
    const ping = (flag, title, body, url) => () => on[flag] && this.notify(title, body, url, flag);

    if (d.bars) {
      const fullAt = b => (!b || b.current >= b.maximum ? 0 : b.fullAt);
      this.timer('energy', fullAt(d.bars.energy), now, ping('energy', 'Energy full', `${d.bars.energy.maximum} energy`, 'https://www.torn.com/gym.php'));
      this.timer('nerve', fullAt(d.bars.nerve), now, ping('nerve', 'Nerve full', `${d.bars.nerve.maximum} nerve`, 'https://www.torn.com/page.php?sid=crimes'));
    }
    if (d.cooldowns) {
      this.timer('drug', d.cooldowns.drug, now, ping('drug', 'Drug cooldown over', 'You can take another drug.', 'https://www.torn.com/item.php'));
      this.timer('booster', d.cooldowns.booster, now, ping('booster', 'Booster cooldown over', 'You can use another booster.', 'https://www.torn.com/item.php'));
      this.timer('medical', d.cooldowns.medical, now, ping('medical', 'Medical cooldown over', 'You can use medical items again.', 'https://www.torn.com/item.php'));
    }
    this.timer('landed', d.travel ? d.travel.arriveAt : 0, now, ping('travel', 'Landed', d.travel ? `You have arrived in ${d.travel.destination}.` : 'You have landed.', 'https://www.torn.com/index.php'));
    const st = d.status;
    const locked = st.state === 'Hospital' || st.state === 'Jail';
    this.timer('released', locked ? st.until : 0, now, ping('hospital', st.state === 'Jail' ? 'Out of jail' : 'Out of hospital', 'Your timer has run out.', 'https://www.torn.com/index.php'));
  }
}

module.exports = { UserFeature };
