// co|op Agent website: login + dashboard (Agent, Logs).
// Talks only to Supabase, using the PUBLISHABLE key. What a person can see is decided by
// row-level security in the database, not by this file. All log text is shown with
// textContent (never as HTML), so nothing in a log row can run as code.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const page = document.body.dataset.page;
  const PAGE_SIZE = 100;
  const REFRESH_MS = 20000;

  const SECRET_MSG =
    'config.js contains a SECRET key. Remove it now. If this file was ever uploaded to GitHub, rotate that key in ' +
    'Supabase (Project Settings → API) right away. Only the publishable key belongs in this file.';

  function showFatal(msg) {
    const f = $('fatal');
    f.querySelector('.box').textContent = msg;
    f.hidden = false;
    const app = $('app');
    if (app) app.hidden = true;
  }

  // ---- settings ---------------------------------------------------------------------------
  function readConfig() {
    const c = window.COOP_CONFIG || {};
    const url = String(c.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
    const key = String(c.SUPABASE_PUBLISHABLE_KEY || '').trim();
    if (!/^https:\/\/[a-z0-9-]{8,}\.supabase\.co$/i.test(url)) {
      return { error: 'Setup problem: SUPABASE_URL in config.js should look like https://yourproject.supabase.co' };
    }
    if (!key || /^PASTE/i.test(key)) return { error: 'Setup needed: add your publishable key to config.js.' };
    if (/^sb_secret_/i.test(key)) return { error: SECRET_MSG };
    if (key.startsWith('eyJ')) {
      let role;
      try {
        const part = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        role = JSON.parse(atob(part)).role;
      } catch {
        return { error: 'The key in config.js does not look right. Copy the publishable (anon) key again.' };
      }
      if (role !== 'anon') return { error: SECRET_MSG };
    } else if (!/^sb_publishable_/i.test(key)) {
      return { error: 'The key in config.js does not look like a publishable key (it starts with sb_publishable_ or eyJ).' };
    }
    const bot = /^[A-Za-z0-9_]{5,32}$/.test(String(c.TELEGRAM_BOT || '')) ? String(c.TELEGRAM_BOT) : '';
    let chatApi = String(c.CHAT_API || '').trim();
    if (chatApi && !(/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\-\/]*)?$/i.test(chatApi) || /^\/(?!\/)[A-Za-z0-9._~\-\/]*$/.test(chatApi))) chatApi = ''; // only an https address (or a path on this site) is accepted
    const lim = parseInt(c.USAGE_LIMIT, 10);
    const usageLimit = Number.isFinite(lim) && lim > 0 && lim <= 10000000 ? lim : 500;
    return { url, key, bot, chatApi, usageLimit };
  }

  // ---- login and sign-up ------------------------------------------------------------------
  async function bootLogin(db) {
    const form = $('form');
    const err = $('err');
    const go = $('go');
    const note = $('note');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const say = (m, warn) => { note.textContent = m; note.classList.toggle('warn', Boolean(warn)); note.hidden = false; };
    let mode = 'login';

    // A "show password" button for a group of fields: only changes what is displayed on this screen.
    function showToggle(btnId, ids, on, off) {
      const btn = $(btnId);
      btn.addEventListener('click', () => {
        const show = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(show));
        btn.textContent = show ? off : on;
        for (const id of ids) $(id).type = show ? 'text' : 'password';
      });
    }
    showToggle('show-pw', ['password', 'password2'], 'Show password', 'Hide password');
    showToggle('show-pw2', ['pw-a', 'pw-b'], 'Show passwords', 'Hide passwords');

    // Coming back from an emailed link. The address carries tokens; remove them from the address bar at once.
    const h = location.hash;
    const hp = new URLSearchParams(h.replace(/^#/, ''));
    const fromEmail = /access_token=|type=signup|type=recovery|error_description=|error_code=/.test(h);
    if (fromEmail) { try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ } }

    // ---- choosing a new password (the link from "Forgot your password?") ----
    if (hp.get('type') === 'recovery' && hp.get('access_token') && hp.get('refresh_token')) {
      return bootReset(db, hp.get('access_token'), hp.get('refresh_token'));
    }

    const { data } = await db.auth.getSession();
    if (data.session) return location.replace('dashboard.html');

    function setMode(m) {
      mode = m;
      const su = m === 'signup';
      const fg = m === 'forgot';
      $('signup-fields').hidden = !su;
      $('pw-wrap').hidden = fg;
      $('forgot-wrap').hidden = m !== 'login';
      $('sub').textContent = su ? 'Create an account. We review every request before an agent is set up.'
        : fg ? 'Enter your email and we’ll send you a link to choose a new password.'
        : 'Log in to see what your agent has been doing.';
      go.textContent = su ? 'Create account' : fg ? 'Send reset link' : 'Log in';
      $('password').autocomplete = su ? 'new-password' : 'current-password';
      $('toggle-text').textContent = m === 'login' ? 'New here?' : su ? 'Already have an account?' : 'Remembered it?';
      $('toggle').textContent = m === 'login' ? 'Create an account' : 'Log in';
      err.hidden = true;
    }
    $('toggle').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
    $('forgot').addEventListener('click', () => { note.hidden = true; setMode('forgot'); });
    $('back-login').addEventListener('click', () => { $('done').hidden = true; form.hidden = false; $('toggle').parentElement.hidden = false; setMode('login'); });
    setMode(location.hash === '#signup' ? 'signup' : 'login');

    if (fromEmail) {
      if (/error_description=|error_code=/.test(h)) say('That email link was already used or has expired. If you already confirmed your email, just log in. If you forgot your password, use “Forgot your password?” below.', true);
      else say('Your email is confirmed. Log in to continue.');
    }

    async function doLogin(email, password) {
      let error;
      try {
        ({ error } = await db.auth.signInWithPassword({ email, password }));
      } catch {
        error = { status: 0 };
      }
      if (!error) return location.replace('dashboard.html');
      go.disabled = false;
      go.textContent = 'Log in';
      if (error.status === 429) fail('Too many tries. Wait a minute and try again.');
      else if (error.status === 400 || error.status === 401 || error.status === 422) fail("That email and password didn't match. Use “Show password” to check what you typed, or “Forgot your password?” below.");
      else fail("Couldn't reach the server. Check your connection and try again.");
    }

    async function doForgot(email) {
      go.disabled = true;
      go.textContent = 'Sending…';
      let error;
      try {
        ({ error } = await db.auth.resetPasswordForEmail(email, { redirectTo: new URL('login.html', location.href).href }));
      } catch {
        error = { status: 0 };
      }
      go.disabled = false;
      go.textContent = 'Send reset link';
      if (error && error.status === 429) return fail('Too many requests. Wait a few minutes and try again.');
      if (error && (error.status === 0 || error.status >= 500)) return fail("Couldn't reach the server. Check your connection and try again.");
      // The same answer whether or not the email has an account, so this page can't be used to find out who does.
      err.hidden = true;
      say('If that email has an account, we’ve sent it a link to choose a new password. Check your inbox and spam folder. The link works for a short time.');
      return undefined;
    }

    async function doSignup(email, password) {
      const use_case = $('use_case').value;
      const business_type = $('business_type').value.trim();
      const business_name = $('business_name').value.trim();
      const notes = $('notes').value.trim();
      if (password.length < 8) return fail('Use a password with at least 8 characters.');
      if (password !== $('password2').value) return fail('The two passwords don’t match. Type the same one in both boxes.');
      if (!business_name) return fail('Enter your business name.');
      if (!business_type) return fail('Tell us what kind of business it is.');
      if (!['tasks', 'dev', 'both', 'other'].includes(use_case)) return fail('Choose what you will use your agent for.');
      go.disabled = true;
      go.textContent = 'Creating…';
      let d; let error;
      try {
        ({ data: d, error } = await db.auth.signUp({
          email, password,
          options: { data: { use_case, business_type, business_name, notes }, emailRedirectTo: new URL('login.html', location.href).href },
        }));
      } catch {
        error = { status: 0 };
      }
      go.disabled = false;
      go.textContent = 'Create account';
      if (!error) {
        if (d && d.session) return location.replace('dashboard.html'); // the project doesn't require email confirmation
        $('done-email').textContent = email;
        $('password').value = '';
        $('password2').value = '';
        form.hidden = true;
        $('toggle').parentElement.hidden = true;
        $('done').hidden = false;
        return undefined; // the same message whether or not the email already had an account
      }
      if (error.status === 429) return fail('Too many sign-ups right now. Wait a while and try again.');
      if (error.code === 'signup_disabled') return fail('Sign-ups are closed right now. Email cooptech126@gmail.com.');
      if (error.code === 'weak_password') return fail('That password is too easy to guess. Try a longer one.');
      if (error.status === 0 || error.status >= 500) return fail("Couldn't reach the server. Check your connection and try again.");
      return fail("Couldn't create the account. Check your details and try again.");
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const email = $('email').value.trim();
      const password = $('password').value;
      if (mode === 'forgot') {
        if (!email) return fail('Enter your email address.');
        return doForgot(email);
      }
      if (!email || !password) return fail('Enter your email and password.');
      if (mode === 'login') {
        go.disabled = true;
        go.textContent = 'Logging in…';
        return doLogin(email, password);
      }
      return doSignup(email, password);
    });
    return undefined;
  }

  // The page you land on from the reset email: sign in with the one-time link, set the new password, sign out.
  async function bootReset(db, accessToken, refreshToken) {
    $('form').hidden = true;
    $('toggle').parentElement.hidden = true;
    $('sub').textContent = 'Choose a new password for your account.';
    const rerr = $('reset-err');
    const rfail = (m) => { rerr.textContent = m; rerr.hidden = false; };
    const finish = () => location.replace('login.html');
    $('reset-login').addEventListener('click', finish);

    let ready = false;
    try {
      const { error } = await db.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      ready = !error;
    } catch { ready = false; }
    if (!ready) {
      $('sub').textContent = '';
      const n = $('note');
      n.textContent = 'That reset link didn’t work, or it has expired. Go back to log in and choose “Forgot your password?” to get a new one.';
      n.classList.add('warn'); n.hidden = false;
      $('reset-done').hidden = false;
      $('reset-done').querySelector('h2').textContent = 'Link expired';
      $('reset-done').querySelector('p').hidden = true;
      return undefined;
    }
    $('reset').hidden = false;
    $('sub').textContent = '';
    $('reset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      rerr.hidden = true;
      const a = $('pw-a').value; const b = $('pw-b').value;
      if (a.length < 8) return rfail('Use a password with at least 8 characters.');
      if (a !== b) return rfail('The two passwords don’t match. Type the same one in both boxes.');
      const btn = $('reset-go');
      btn.disabled = true; btn.textContent = 'Saving…';
      let error;
      try { ({ error } = await db.auth.updateUser({ password: a })); } catch { error = { status: 0 }; }
      btn.disabled = false; btn.textContent = 'Save new password';
      if (error) {
        if (error.code === 'same_password') return rfail('Choose a password you haven’t used before on this account.');
        if (error.code === 'weak_password') return rfail('That password is too easy to guess. Try a longer one.');
        if (error.status === 0 || error.status >= 500) return rfail("Couldn't reach the server. Check your connection and try again.");
        return rfail('That link may have expired. Go back to log in and choose “Forgot your password?” again.');
      }
      try { await db.auth.signOut(); } catch { /* the password is already changed */ }
      $('reset').hidden = true;
      $('sub').textContent = '';
      $('reset-done').hidden = false;
      return undefined;
    });
    return undefined;
  }

  // ---- dashboard --------------------------------------------------------------------------
  const LABEL = {
    add: 'Added two numbers', multiply: 'Multiplied two numbers', weather: 'Looked up the weather',
    add_note: 'Saved a note', list_notes: 'Read back your notes', list_events: 'Checked your calendar', create_event: 'Added a calendar event',
    agent_create: 'Created an agent', agent_run: 'Ran an agent', agent_delete: 'Deleted an agent',
    draft_email: 'Saved an email draft', write_file: 'Created a file', write_excel: 'Created a spreadsheet',
    view_excel: 'Opened a spreadsheet', edit_excel: 'Edited a spreadsheet', code_task: 'Prepared a code change',
    push_change: 'Opened a pull request', cloud_ok: 'Allowed cloud AI for code', list_repos: 'Listed your repositories',
    list_prs: 'Listed pull requests', build_status: 'Checked build status', disconnect: 'Disconnected an account',
    remove_model: 'Removed an AI model', chat: 'Chatted', fact: 'Answered a quick question', help: 'Gave help',
    limit: "Declined something it can't do", ask: 'Asked for more detail', unknown: 'Hit a problem',
  };
  const STATUS = {
    done: ['Done', 'done'], asked: ['Waiting for your yes', 'asked'], cancelled: ['Cancelled', 'cancelled'],
    blocked: ['Held back', 'blocked'], failed: ['Failed', 'failed'],
  };
  const labelFor = (r) => {
    if (r.kind === 'command') return `Used ${r.action || 'a command'}`;
    if (r.kind === 'blocked') return r.action === 'ask' ? 'Asked for more detail' : 'Wasn’t sure what you meant';
    return LABEL[r.action] || (r.action ? String(r.action).replace(/_/g, ' ') : 'Did something');
  };
  const noteFor = (r) => {
    if (r.kind === 'blocked' && r.proposed) {
      return `Guessed “${LABEL[r.proposed] || r.proposed}”, but the message didn’t clearly ask for it, so it did nothing.`;
    }
    return r.reason || '';
  };
  const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  const fmtWhen = (ts) => {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  async function bootDashboard(db, cfg) {
    const { data } = await db.auth.getSession();
    if (!data.session) return location.replace('login.html');
    let leaving = false;
    const goLogin = () => { if (leaving) return; leaving = true; location.replace('login.html'); }; // only ever one navigation
    db.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') goLogin(); });

    $('who').textContent = data.session.user.email || '';
    $('out').addEventListener('click', async () => { try { await db.auth.signOut(); } finally { goLogin(); } });
    if (cfg.bot) { const a = $('open-tg'); a.href = `https://t.me/${cfg.bot}`; a.hidden = false; }
    $('app').hidden = false;

    const sessionExpired = () => { db.auth.signOut().finally(goLogin); };
    const isAuthError = (e) => e && (e.status === 401 || e.code === 'PGRST301' || /jwt/i.test(e.message || ''));

    // which view is showing
    const VIEWS = ['chat', 'calendar', 'agents', 'tools', 'start', 'logs', 'help', 'settings'];
    const TOOL_PAGES = new Set(['tool-email', 'tool-files', 'tool-notes', 'tool-github']); // each tool's own page, listed under Tools in the sidebar
    const NEEDS_AGENT = new Set(['chat', 'calendar', 'agents', 'tools', 'logs']); // Get started, Help and Settings work for anyone
    const rawHash = location.hash.slice(1);
    const fromHash = rawHash === 'agent' ? 'agents' : rawHash === 'schedule' ? 'calendar' : rawHash; // old links: the Agent page lives under Agents, Schedule became Calendar
    let view = VIEWS.includes(fromHash) || TOOL_PAGES.has(fromHash) ? fromHash : null; // chosen after we know if the login is linked
    let linked = null; // null = not known yet
    function show(v) {
      view = v;
      const real = TOOL_PAGES.has(v) ? 'tools' : v; // a tool's page is the Tools page showing that tool
      try { history.replaceState(null, '', `#${v}`); } catch { /* ignore */ }
      for (const b of document.querySelectorAll('.side button[data-view]')) {
        if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      }
      const inTools = real === 'tools' || real === 'calendar'; // the Tools list in the sidebar is open while you are in any tool
      $('toolsub').hidden = !inTools;
      $('tools-toggle').setAttribute('aria-expanded', String(inTools));
      const blocked = NEEDS_AGENT.has(real) && linked === false;
      $('unlinked').hidden = !blocked;
      for (const name of VIEWS) {
        const open = name === real && (!NEEDS_AGENT.has(name) || linked === true);
        $(`view-${name}`).hidden = !open;
      }
      if (real === 'tools') { if (TOOL_PAGES.has(v)) tools.open(v.slice(5)); else tools.close(); }
      if (real === 'logs' && linked === true && !logs.started) logs.start();
      if (real === 'tools' && linked === true) tools.load();
      if (real === 'calendar' && linked === true) { calendar.load(); tools.load(); }
      if (real === 'agents' && linked === true) agentsView.load();
      if (real === 'settings') settings.open();
    }
    for (const b of document.querySelectorAll('.side button[data-view]')) {
      b.addEventListener('click', () => {
        if (b.classList.contains('newchat')) chat.reset(); // New chat clears the conversation on this page
        show(b.dataset.view);
      });
    }

    // ---- schedule + agents: these talk to the bot's /web/schedule and /web/agents (same login as chat)
    const webBase = /\/chat$/.test(cfg.chatApi || '') ? cfg.chatApi.replace(/\/chat$/, '') : '';
    async function webCall(method, path, body) {
      if (!webBase) return { status: 0, body: { error: 'off' } };
      const { data: s } = await db.auth.getSession();
      const token = s.session && s.session.access_token;
      if (!token) { sessionExpired(); return { status: 401, body: {} }; }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      try {
        const res = await fetch(webBase + path, {
          method, signal: ctl.signal,
          headers: { Authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 401) { sessionExpired(); return { status: 401, body: {} }; }
        let out = null; try { out = await res.json(); } catch { /* not json */ }
        return { status: res.status, body: out && typeof out === 'object' ? out : {} };
      } catch { return { status: 0, body: { error: 'network' } }; } finally { clearTimeout(timer); }
    }
    const webError = (r, fallback) => {
      if (r.body && typeof r.body.message === 'string' && r.body.message) return r.body.message.slice(0, 400);
      if (r.status === 0) return webBase ? "Couldn't reach your agent. Check that it's running, then try again." : "This page isn't connected to your agent yet.";
      if (r.status === 429) return 'Slow down a little and try again in a minute.';
      if (r.status === 409 && r.body.error === 'not_linked') return 'Link this login to your agent first (see Get started).';
      if (r.status >= 500) return 'Something went wrong on the agent’s side. Try again in a moment.';
      return fallback;
    };
    const tzDay = (d, tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); } catch { return d.toISOString().slice(0, 10); } };
    const clockStr = (d, tz) => { try { return d.toLocaleTimeString([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }); } catch { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } };
    const plusDay = (key, n) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
    const dayTitle = (key, today) => {
      const base = new Date(`${key}T12:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
      return key === today ? `Today · ${base}` : key === plusDay(today, 1) ? `Tomorrow · ${base}` : base;
    };
    const setNote = (box, text) => { box.hidden = !text; box.textContent = text || ''; };

    const calendar = {
      data: null, busy: false, confirmPayload: null, month: null, sel: null,
      gridStart() { // the Sunday on or before the 1st: where the month grid begins
        const first = new Date(Date.UTC(this.month.y, this.month.m - 1, 1));
        return new Date(first.getTime() - first.getUTCDay() * 864e5).toISOString().slice(0, 10);
      },
      monthKey() { return `${this.month.y}-${String(this.month.m).padStart(2, '0')}`; },
      async load(quiet) {
        if (this.busy) return;
        if (!this.month) { const n = new Date(); this.month = { y: n.getFullYear(), m: n.getMonth() + 1 }; }
        this.busy = true;
        if (!quiet) $('sch-updated').textContent = 'Loading…';
        const r = await webCall('GET', `/schedule?from=${this.gridStart()}&days=42`);
        this.busy = false;
        if (r.status !== 200) {
          $('sch-updated').textContent = '';
          if (!this.data || !quiet) { this.data = null; $('cal-grid').replaceChildren(); $('sch-list').replaceChildren(); setNote($('sch-note'), webError(r, "Couldn't load your calendar. Try Refresh in a moment.")); $('sch-add').disabled = true; }
          return;
        }
        this.data = r.body;
        if (!this.sel || this.sel < this.data.from || this.sel > plusDay(this.data.from, 41)) this.sel = this.monthKey() === this.data.today.slice(0, 7) ? this.data.today : `${this.monthKey()}-01`;
        this.render();
        $('sch-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      },
      buckets() {
        const d = this.data, tz = d.tz, by = new Map();
        const at = (k) => { if (!by.has(k)) by.set(k, { allDay: [], timed: [], runs: [] }); return by.get(k); };
        for (const e of d.events) {
          const title = e.title || '(no title)';
          if (e.allDay) {
            const s0 = String(e.start).slice(0, 10), e0 = e.end ? String(e.end).slice(0, 10) : plusDay(s0, 1);
            for (let k = s0, i = 0; k < e0 && i < 14; k = plusDay(k, 1), i += 1) at(k).allDay.push({ text: title });
          } else {
            const t = new Date(e.start);
            if (!Number.isNaN(t.getTime())) at(tzDay(t, tz)).timed.push({ at: t.getTime(), when: clockStr(t, tz), text: title });
          }
        }
        for (const r of d.runs) { const t = new Date(r.at); if (!Number.isNaN(t.getTime())) at(tzDay(t, tz)).runs.push({ at: t.getTime(), when: clockStr(t, tz), text: r.name }); }
        for (const v of by.values()) { v.timed.sort((a, b) => a.at - b.at); v.runs.sort((a, b) => a.at - b.at); }
        return by;
      },
      render() {
        const d = this.data, grid = $('cal-grid'), by = this.buckets();
        $('sch-sub').textContent = `Your Google Calendar and when your agents will run. Times are in ${String(d.tz).replace(/_/g, ' ')}.`;
        $('cal-title').textContent = new Date(Date.UTC(this.month.y, this.month.m - 1, 1)).toLocaleDateString([], { timeZone: 'UTC', month: 'long', year: 'numeric' });
        const notes = { off: "Calendar isn't switched on for your account.", not_connected: 'Your calendar isn’t connected yet. In Telegram, send /connect google to your agent.', reconnect: 'Your Google connection expired. In Telegram, send /connect google to your agent.', unavailable: 'Google didn’t answer just now. Try Refresh in a moment.' };
        setNote($('sch-note'), notes[d.calendar] || '');
        $('sch-add').disabled = d.calendar !== 'ok';
        if (!$('sch-date').value) $('sch-date').value = this.sel;
        grid.replaceChildren();
        for (let i = 0; i < 7; i += 1) grid.append(el('div', 'dow', new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString([], { timeZone: 'UTC', weekday: 'short' })));
        const start = this.gridStart();
        for (let i = 0; i < 42; i += 1) {
          const key = plusDay(start, i), b = by.get(key) || { allDay: [], timed: [], runs: [] };
          const cell = el('button', `calcell${key.slice(0, 7) !== this.monthKey() ? ' out' : ''}${key === d.today ? ' today' : ''}${key === this.sel ? ' sel' : ''}`);
          cell.type = 'button'; cell.dataset.date = key;
          const items = [...b.allDay.map((x) => ({ cls: 'ev allday', text: x.text })), ...b.timed.map((x) => ({ cls: 'ev', text: `${x.when.replace(':00', '').replace(' ', '').toLowerCase()} ${x.text}` })), ...b.runs.map((x) => ({ cls: 'ag', text: `${x.name}` }))];
          cell.setAttribute('aria-label', `${dayTitle(key, d.today)}: ${b.allDay.length + b.timed.length} events${b.runs.length ? `, ${b.runs.length} agent runs` : ''}`);
          cell.append(el('span', 'num', String(Number(key.slice(8)))));
          for (const it of items.slice(0, 3)) cell.append(el('span', `chip ${it.cls}`, it.text));
          if (items.length > 3) cell.append(el('span', 'more', `+${items.length - 3} more`));
          if (items.length) { const dots = el('span', 'dots'); for (const it of items.slice(0, 3)) dots.append(el('i', it.cls.startsWith('ag') ? 'a' : '')); cell.append(dots); }
          cell.addEventListener('click', () => this.select(key));
          grid.append(cell);
        }
        this.renderDay(by);
      },
      renderDay(by) {
        const d = this.data, key = this.sel, list = $('sch-list');
        by = by || this.buckets();
        $('cal-day-title').textContent = dayTitle(key, d.today);
        for (const c of $('cal-grid').querySelectorAll('.calcell')) c.classList.toggle('sel', c.dataset.date === key);
        const b = by.get(key) || { allDay: [], timed: [], runs: [] };
        list.replaceChildren();
        const row = (when, text, agent) => {
          const r = el('div', agent ? 'item agentrun' : 'item');
          r.append(el('span', 'when', when));
          const w = el('span', 'what', text);
          if (agent) w.append(el('span', 'tag', 'agent'));
          r.append(w); list.append(r);
        };
        for (const x of b.allDay) row('All day', x.text, false);
        for (const x of b.timed) row(x.when, x.text, false);
        for (const x of b.runs) row(x.when, `${x.text} runs`, true);
        if (!list.children.length) list.append(el('p', 'muted', d.calendar === 'ok' ? 'Nothing on this day.' : 'Nothing to show yet.'));
        for (const x of d.beforeEvent) list.append(el('p', 'muted small', `${x.name} sends you a brief ${x.minutes} minutes before each event.`));
      },
      select(key) {
        this.sel = key; $('sch-date').value = key; this.clearConfirm();
        if (this.data) this.renderDay();
      },
      go(delta) { // months forward or back
        const n = new Date(Date.UTC(this.month.y, this.month.m - 1 + delta, 1));
        this.month = { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1 };
        this.sel = null; this.data = null; $('cal-grid').replaceChildren(); this.load();
      },
      today() { const n = this.data ? this.data.today : tzDay(new Date()); this.month = { y: Number(n.slice(0, 4)), m: Number(n.slice(5, 7)) }; this.sel = n; this.data = null; this.load(); },
      clearConfirm() { this.confirmPayload = null; $('sch-confirm').hidden = true; $('sch-confirm').replaceChildren(); },
      async add(force) {
        const msg = $('sch-msg');
        const payload = force && this.confirmPayload ? { ...this.confirmPayload, force: true } : {
          title: $('sch-title').value.trim(), date: $('sch-date').value, time: $('sch-time').value, minutes: Number($('sch-mins').value) || 60,
        };
        if (!payload.title) { msg.textContent = 'Give the event a name.'; return; }
        if (!payload.date || !payload.time) { msg.textContent = 'Pick a day and a start time.'; return; }
        this.clearConfirm();
        $('sch-add').disabled = true; msg.textContent = 'Adding…';
        const r = await webCall('POST', '/schedule/event', payload);
        $('sch-add').disabled = !this.data || this.data.calendar !== 'ok';
        if (r.status === 200 && r.body.needsConfirm) {
          msg.textContent = '';
          this.confirmPayload = { title: payload.title, date: payload.date, time: payload.time, minutes: payload.minutes };
          const box = $('sch-confirm');
          box.append(el('div', null, `That overlaps with ${(r.body.clash || []).map((c) => `${String(c.title).slice(0, 60)} (${clockStr(new Date(c.start), this.data ? this.data.tz : undefined)})`).join(', ')}. Add it anyway?`));
          const row = el('div', 'row');
          const yes = el('button', 'btn small', 'Add anyway'); yes.type = 'button'; yes.addEventListener('click', () => this.add(true));
          const no = el('button', 'btn ghost small', 'Cancel'); no.type = 'button'; no.addEventListener('click', () => { this.clearConfirm(); msg.textContent = 'Not added.'; });
          row.append(yes, no); box.append(row); box.hidden = false;
          return;
        }
        if (r.status === 200 && r.body.ok) {
          msg.textContent = `Added “${payload.title}” to your calendar.`;
          $('sch-title').value = '';
          this.load(true);
          return;
        }
        msg.textContent = webError(r, "That didn't work. Nothing was added.");
      },
    };
    $('sch-refresh').addEventListener('click', () => calendar.load());
    $('cal-prev').addEventListener('click', () => calendar.go(-1));
    $('cal-next').addEventListener('click', () => calendar.go(1));
    $('cal-today').addEventListener('click', () => calendar.today());
    $('sch-form').addEventListener('submit', (e) => { e.preventDefault(); calendar.add(false); });
    for (const id of ['sch-title', 'sch-date', 'sch-time', 'sch-mins']) $(id).addEventListener('input', () => calendar.clearConfirm());
    setInterval(() => { if (view === 'calendar' && linked === true && !document.hidden) calendar.load(true); }, 60000);

    const AGENT_EXAMPLES = ['every weekday at 8am', 'daily at 5:30pm', 'tomorrow at 9am', '30 minutes before every meeting', 'only when I ask'];
    const agentsView = {
      data: null, busy: false, out: {}, editing: null, armed: null, editId: null,
      async load(quiet) {
        if (this.busy) return;
        this.busy = true;
        const r = await webCall('GET', '/agents');
        this.busy = false;
        if (r.status !== 200) {
          if (!this.data || !quiet) { this.data = null; $('ag-list').replaceChildren(); this.closeForm(); $('ag-new').disabled = true; setNote($('ag-note'), webError(r, "Couldn't load your agents. Try Refresh in a moment.")); }
          return;
        }
        this.data = r.body; setNote($('ag-note'), ''); this.render();
      },
      toolLabel(k) { const t = this.data.tools.find((x) => x.key === k); return k === 'sheet' ? 'Spreadsheet' : (t ? t.label : k); },
      render() {
        const d = this.data, list = $('ag-list');
        $('ag-sub').textContent = `${d.agents.length} of ${d.cap} agents. Each one does one job for you, on a schedule you choose.`;
        list.replaceChildren();
        if (!d.agents.length) list.append(el('p', 'muted', 'No agents yet. Build your first one below.'));
        for (const a of d.agents) list.append(this.card(a));
        const full = d.agents.length >= d.cap;
        $('ag-new').disabled = full;
        $('ag-new').title = full ? `You have ${d.cap} agents, the most you can have right now.` : '';
        if (full) setNote($('ag-note'), `You have ${d.cap} agents, the most you can have right now. Delete one to build another.`);
        this.renderTools();
      },
      card(a) {
        const c = el('div', 'panel agentcard');
        const h = el('h2', null, a.name);
        h.append(el('span', `state ${a.state}`, a.state));
        c.append(h);
        c.append(el('p', 'meta', a.purpose));
        if (a.info) c.append(el('p', 'meta', `Knows: ${a.info}`));
        c.append(el('p', 'meta', `When: ${a.scheduleText}`));
        c.append(el('p', 'meta', `Looks at: ${a.tools.length ? a.tools.map((k) => (k === 'sheet' && a.sheet ? `Spreadsheet (${a.sheet})` : this.toolLabel(k))).join(', ') : 'nothing (it just writes you a message)'}`));
        c.append(el('p', 'meta', a.lastRunAt ? `Last ran ${new Date(a.lastRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${a.lastStatus ? ` · ${a.lastStatus}` : ''} · ${a.runs} run${a.runs === 1 ? '' : 's'}` : 'Hasn’t run yet.'));
        const row = el('div', 'row');
        const mk = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', () => fn(b)); row.append(b); return b; };
        mk('Run now', 'btn small', (b) => this.run(a, b));
        if (a.state !== 'done') mk(a.enabled ? 'Pause' : 'Resume', 'btn ghost small', () => this.verb(a, a.enabled ? 'pause' : 'resume'));
        mk('Edit', 'btn ghost small', () => this.startEdit(a));
        mk('Change time', 'btn ghost small', () => { this.editing = this.editing === a.id ? null : a.id; this.render(); });
        mk(this.armed === a.id ? 'Click again to delete' : 'Delete', 'btn ghost small', (b) => {
          if (this.armed === a.id) { this.armed = null; this.verb(a, 'delete'); return; }
          this.armed = a.id; b.textContent = 'Click again to delete';
          setTimeout(() => { if (this.armed === a.id) { this.armed = null; if (b.isConnected) b.textContent = 'Delete'; } }, 4000);
        });
        c.append(row);
        if (this.editing === a.id) {
          const s = el('form', 'sched');
          const inp = el('input'); inp.type = 'text'; inp.maxLength = 120; inp.placeholder = 'every weekday at 8am'; inp.value = '';
          inp.setAttribute('aria-label', 'New time');
          const save = el('button', 'btn small', 'Save'); save.type = 'submit';
          const msg = el('p', 'muted small'); msg.setAttribute('role', 'status');
          s.append(inp, save);
          s.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!inp.value.trim()) { msg.textContent = 'Type when it should run.'; return; }
            save.disabled = true; const r = await webCall('POST', `/agents/${encodeURIComponent(a.id)}/schedule`, { schedule: inp.value.trim() }); save.disabled = false;
            if (r.status === 200) { this.editing = null; this.load(true); } else msg.textContent = webError(r, "I didn't catch that time.");
          });
          c.append(s, msg);
          const chips = el('p', 'chips');
          for (const ex of AGENT_EXAMPLES) { const b = el('button', null, ex); b.type = 'button'; b.addEventListener('click', () => { inp.value = ex; }); chips.append(b); }
          c.append(chips);
        }
        if (this.out[a.id]) c.append(el('div', 'out', this.out[a.id]));
        return c;
      },
      async run(a, btn) {
        btn.disabled = true; btn.textContent = 'Running…';
        const r = await webCall('POST', `/agents/${encodeURIComponent(a.id)}/run`, {});
        this.out[a.id] = r.status === 200 && r.body.ok ? ((r.body.text || 'Done.') + (r.body.notified ? '\n\n✓ Also sent to your Telegram.' : '')) : webError(r, "It didn't run. Try again in a moment.");
        await this.load(true);
        this.render();
      },
      async verb(a, verb) {
        const r = await webCall('POST', `/agents/${encodeURIComponent(a.id)}/${verb}`, {});
        if (r.status !== 200 && r.status !== 404) { this.out[a.id] = webError(r, 'That did not work.'); this.render(); return; }
        delete this.out[a.id];
        await this.load(true);
      },
      startEdit(a) {
        this.editId = a.id;
        $('ag-purpose').value = a.purpose; $('ag-info').value = a.info || ''; $('ag-name').value = a.name; $('ag-sheet').value = a.sheet || '';
        $('ag-schedule').value = ''; $('ag-schedule').placeholder = `Leave empty to keep: ${a.scheduleText}`;
        for (const i of $('ag-tools').querySelectorAll('input')) i.checked = !i.disabled && a.tools.includes(i.value);
        $('ag-sheet-row').hidden = !$('ag-tools').querySelector('input[value=sheet]:checked');
        $('ag-form-title').textContent = `Edit ${a.name}`; $('ag-create').textContent = 'Save changes';
        $('ag-msg').textContent = ''; this.openForm();
        $('ag-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      stopEdit() {
        this.editId = null;
        for (const id of ['ag-purpose', 'ag-info', 'ag-sheet', 'ag-schedule', 'ag-name']) $(id).value = '';
        $('ag-schedule').placeholder = 'every weekday at 8am';
        for (const i of $('ag-tools').querySelectorAll('input')) i.checked = false;
        $('ag-sheet-row').hidden = true;
        $('ag-form-title').textContent = 'Build an agent'; $('ag-create').textContent = 'Create agent';
        this.closeForm();
      },
      openForm() { $('ag-form').hidden = false; $('ag-new').hidden = true; },
      closeForm() { $('ag-form').hidden = true; $('ag-new').hidden = false; },
      renderTools() {
        const box = $('ag-tools');
        const keep = new Set([...box.querySelectorAll('input:checked')].map((i) => i.value));
        for (const n of [...box.querySelectorAll('label')]) n.remove();
        for (const t of this.data.tools) {
          const l = el('label'); const i = el('input'); i.type = 'checkbox'; i.value = t.key; i.disabled = !t.usable; i.checked = t.usable && keep.has(t.key);
          i.addEventListener('change', () => { $('ag-sheet-row').hidden = !box.querySelector('input[value=sheet]:checked'); });
          const s = el('span', null, t.label); s.append(el('span', 'why', t.usable ? t.does : `Not available yet: ${t.why}`));
          l.append(i, s); box.append(l);
        }
        $('ag-sheet-row').hidden = !box.querySelector('input[value=sheet]:checked');
      },
      async create() {
        const msg = $('ag-msg');
        const editing = this.editId;
        const purpose = $('ag-purpose').value.trim();
        if (purpose.length < 5) { msg.textContent = 'Say what the agent should do (a short sentence is fine).'; return; }
        if (!editing && !$('ag-schedule').value.trim()) { msg.textContent = 'Say when it should run, or tap an example.'; return; }
        const tools = [...$('ag-tools').querySelectorAll('input:checked')].map((i) => i.value);
        const payload = { purpose, info: $('ag-info').value.trim(), tools, sheet: $('ag-sheet').value.trim(), schedule: $('ag-schedule').value.trim(), name: $('ag-name').value.trim() };
        $('ag-create').disabled = true; msg.textContent = editing ? 'Saving…' : 'Creating…';
        const r = await webCall('POST', editing ? `/agents/${encodeURIComponent(editing)}/update` : '/agents', payload);
        $('ag-create').disabled = false;
        if ((r.status === 201 || (editing && r.status === 200)) && r.body.ok) {
          const name = r.body.agent.name;
          if (editing) this.stopEdit(); else { for (const id of ['ag-purpose', 'ag-info', 'ag-sheet', 'ag-schedule', 'ag-name']) $(id).value = ''; for (const i of $('ag-tools').querySelectorAll('input')) i.checked = false; $('ag-sheet-row').hidden = true; this.closeForm(); }
          msg.textContent = editing ? `Saved “${name}”.` : `Created “${name}”.`;
          await this.load(true);
          return;
        }
        if (editing && r.status === 404) { this.stopEdit(); msg.textContent = 'That agent is already gone.'; await this.load(true); return; }
        msg.textContent = webError(r, 'That did not work. Nothing was saved.');
        if (r.status === 409 && r.body.error === 'cap') this.load(true);
      },
    };
    $('ag-cancel').addEventListener('click', () => { agentsView.stopEdit(); $('ag-msg').textContent = ''; });
    $('ag-new').addEventListener('click', () => { agentsView.stopEdit(); agentsView.openForm(); $('ag-msg').textContent = ''; $('ag-purpose').focus(); $('ag-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    $('ag-refresh').addEventListener('click', () => agentsView.load());
    $('ag-form').addEventListener('submit', (e) => { e.preventDefault(); agentsView.create(); });
    { const chips = $('ag-chips'); for (const ex of AGENT_EXAMPLES) { const b = el('button', null, ex); b.type = 'button'; b.addEventListener('click', () => { $('ag-schedule').value = ex; }); chips.append(b); } }

    // ---- logs
    const logs = {
      started: false, mode: 'actions', rows: [], busy: false, more: false, queue: [],
      maxId() { return this.rows.length ? this.rows[0].id : 0; },
      minId() { return this.rows.length ? this.rows[this.rows.length - 1].id : 0; },
      query() {
        let q = db.from('agent_logs')
          .select('id,ts,kind,action,status,detail,proposed,reason,ms,business')
          .order('id', { ascending: false }).limit(PAGE_SIZE);
        if (this.mode === 'actions') q = q.neq('kind', 'chat');
        return q;
      },
      async run(fn) {
        if (this.busy) { this.queue.push(fn); return; } // run it right after the current load
        this.busy = true;
        $('err').hidden = true;
        try { await fn(); $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`; }
        catch (e) {
          if (isAuthError(e)) return sessionExpired();
          $('err').textContent = "Couldn't load the logs. Try Refresh in a moment.";
          $('err').hidden = false;
        } finally {
          this.busy = false;
          this.render();
          const next = this.queue.shift();
          if (next) this.run(next);
        }
      },
      async fetchRows(q) {
        const { data: rows, error } = await q;
        if (error) throw error;
        return rows || [];
      },
      start() { this.started = true; charts.load(); this.reload(); setInterval(() => { if (document.visibilityState === 'visible' && view === 'logs') this.fresh(); }, REFRESH_MS); },
      reload() { return this.run(async () => { const r = await this.fetchRows(this.query()); this.rows = r; this.more = r.length === PAGE_SIZE; }); },
      fresh() { return this.run(async () => { const r = await this.fetchRows(this.query().gt('id', this.maxId())); this.rows = r.concat(this.rows); }); },
      older() { return this.run(async () => { const r = await this.fetchRows(this.query().lt('id', this.minId())); this.rows = this.rows.concat(r); this.more = r.length === PAGE_SIZE; }); },
      render() {
        const body = $('rows');
        body.replaceChildren();
        for (const r of this.rows) {
          const tr = el('tr');
          tr.appendChild(el('td', 'when', fmtWhen(r.ts)));
          const what = el('td', 'what');
          what.appendChild(el('b', null, labelFor(r)));
          if (r.detail) what.appendChild(el('span', 'detail', r.detail));
          tr.appendChild(what);
          const [text, cls] = STATUS[r.status] || [r.status || '—', 'other'];
          const res = el('td');
          res.appendChild(el('span', `badge b-${cls}`, text));
          if (r.ms != null) res.appendChild(el('span', 'ms', fmtMs(r.ms)));
          tr.appendChild(res);
          tr.appendChild(el('td', 'note muted', noteFor(r)));
          body.appendChild(tr);
        }
        const empty = $('empty');
        const none = this.rows.length === 0 && !this.busy;
        empty.hidden = !none;
        empty.textContent = this.mode === 'actions'
          ? 'Nothing yet. Message your agent in Telegram and what it does will show up here. Switch to “Everything” to include plain chat.'
          : 'Nothing yet. Message your agent in Telegram and it will show up here.';
        $('tbl').hidden = this.rows.length === 0;
        $('older').hidden = !this.more;
      },
    };
    for (const b of document.querySelectorAll('.seg button')) {
      b.addEventListener('click', () => {
        logs.mode = b.dataset.mode;
        for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-pressed', String(x === b));
        logs.rows = []; logs.more = false; logs.reload();
      });
    }
    $('refresh').addEventListener('click', () => { logs.fresh(); charts.load(); });
    $('older').addEventListener('click', () => logs.older());

    // ---- little helpers shared by the pages below
    const tipEl = el('div', 'tip');
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    function showTip(e, text) {
      tipEl.textContent = text;
      tipEl.hidden = false;
      tipEl.style.left = `${Math.max(8, Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8))}px`;
      tipEl.style.top = `${e.clientY + 16}px`;
    }
    const hideTip = () => { tipEl.hidden = true; };
    function bindCopy(root) {
      for (const b of root.querySelectorAll('[data-copy]')) {
        if (b.dataset.bound) continue;
        b.dataset.bound = '1';
        b.addEventListener('click', async () => {
          const old = b.dataset.label || (b.dataset.label = b.textContent);
          try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy it by hand'; }
          setTimeout(() => { b.textContent = old; }, 1500);
        });
      }
    }
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
      return n;
    };

    // ---- tools: one place for each app the agent can use (what it did, and how to connect or disconnect it)
    const TOOLS = [
      {
        id: 'calendar', name: 'Calendar', view: 'calendar', blurb: 'Your Google Calendar: your agent reads it and adds events you approve.',
        can: ['Reads your Google Calendar to answer questions and to write your agents’ messages.', 'Only after your yes, adds an event. It never changes or deletes events you already have.'],
        actions: ['list_events', 'create_event'], connect: '/connect google', disconnect: '/disconnect google',
        hint: 'On Google’s screen, tick Select all before you continue. The boxes start unticked, and the agent needs both to work.',
      },
      {
        id: 'email', name: 'Email', blurb: 'Gmail drafts for you to look over.',
        can: ['Saves email drafts in Gmail for you to look over. It never sends email and never reads your inbox.'],
        actions: ['draft_email'], connect: '/connect google', disconnect: '/disconnect google',
        hint: 'Email and Calendar share one Google sign-in. On Google’s screen, tick Select all before you continue.',
      },
      {
        id: 'files', name: 'Files and spreadsheets', blurb: 'Files and spreadsheets the agent makes for you.',
        can: ['Creates and edits text files and spreadsheets in your own workspace.'],
        actions: ['write_file', 'write_excel', 'view_excel', 'edit_excel'], names: true,
      },
      {
        id: 'notes', name: 'Notes', blurb: 'Quick notes you ask it to keep.',
        can: ['Keeps short notes and reads them back to you.'],
        actions: ['add_note', 'list_notes'],
      },
      {
        id: 'github', name: 'GitHub', blurb: 'The code projects you choose.',
        can: ['Looks at the projects you choose.', 'Only after your yes, puts a change on a new branch as a pull request. It never changes your main branch.'],
        actions: ['list_repos', 'list_prs', 'build_status', 'code_task', 'cloud_ok', 'push_change'], names: true,
        connect: '/connect github', disconnect: '/disconnect github',
      },
    ];
    let toolOpen = null; // the tool whose page is showing, or null for the list
    const tools = {
      busy: false, rows: [],
      async load() {
        if (this.busy) return;
        this.busy = true;
        const err = $('tools-err');
        err.hidden = true;
        try {
          const { data: rows, error } = await db.from('agent_logs').select('ts,kind,action,status,detail')
            .neq('kind', 'chat').order('id', { ascending: false }).limit(1000);
          if (error) throw error;
          this.rows = rows || [];
          this.render();
          $('tools-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        } catch (e) {
          if (isAuthError(e)) return sessionExpired();
          err.textContent = "Couldn't load your tools. Try Refresh in a moment.";
          err.hidden = false;
        } finally { this.busy = false; }
      },
      mine(t) { return this.rows.filter((r) => t.actions.includes(r.action)); },
      render() {
        const box = $('tools-grid');
        box.replaceChildren();
        for (const t of TOOLS) {
          const mine = this.mine(t);
          const done = mine.filter((r) => r.status === 'done').length;
          const failed = mine.filter((r) => r.status === 'failed').length;
          const card = el('button', 'conn');
          card.type = 'button';
          card.dataset.tool = t.id;
          card.appendChild(el('h2', null, t.name));
          card.appendChild(el('p', 'muted small', t.blurb));
          if (!done && !failed) card.appendChild(el('p', 'conn-none', 'Not used yet'));
          else {
            const big = el('p', 'conn-count');
            big.appendChild(el('strong', null, String(done)));
            big.appendChild(document.createTextNode(done === 1 ? ' time used' : ' times used'));
            if (failed) big.appendChild(el('span', 'badge b-failed', `${failed} failed`));
            card.appendChild(big);
          }
          card.appendChild(el('span', 'tool-open', 'OPEN →'));
          card.addEventListener('click', () => show(t.view || `tool-${t.id}`));
          box.appendChild(card);
        }
        if (toolOpen) this.renderDetail(toolOpen);
        this.fill(TOOLS.find((x) => x.id === 'calendar'), { usage: $('cd-usage'), manage: $('cd-manage'), rows: $('cd-rows'), none: $('cd-none'), tbl: $('cd-tbl') });
      },
      open(id) { toolOpen = id; this.renderDetail(id); },
      close() { toolOpen = null; $('tool-detail').hidden = true; $('tools-list').hidden = false; },
      renderDetail(id) {
        const t = TOOLS.find((x) => x.id === id);
        if (!t) return this.close();
        $('tools-list').hidden = true;
        $('tool-detail').hidden = false;
        $('td-name').textContent = t.name;
        $('td-blurb').textContent = t.blurb;
        this.fill(t, { usage: $('td-usage'), manage: $('td-manage'), rows: $('td-rows'), none: $('td-none'), tbl: $('td-tbl') });
      },
      fill(t, els) {
        const mine = this.mine(t);
        const done = mine.filter((r) => r.status === 'done');
        const failed = mine.filter((r) => r.status === 'failed').length;
        // what it can do and what it has done
        const u = els.usage;
        u.replaceChildren();
        u.appendChild(el('h2', null, 'What it can do'));
        const ul = el('ul');
        for (const c of t.can) ul.appendChild(el('li', null, c));
        u.appendChild(ul);
        u.appendChild(el('h2', null, 'What it has done'));
        if (!done.length && !failed) u.appendChild(el('p', 'conn-none', 'Not used yet.'));
        else {
          const big = el('p', 'conn-count');
          big.appendChild(el('strong', null, String(done.length)));
          big.appendChild(document.createTextNode(done.length === 1 ? ' time used' : ' times used'));
          if (failed) big.appendChild(el('span', 'badge b-failed', `${failed} failed`));
          u.appendChild(big);
          if (done.length) u.appendChild(el('p', 'muted small', `Last used ${fmtWhen(done[0].ts)}`));
          const by = new Map();
          for (const r of done) by.set(r.action, (by.get(r.action) || 0) + 1);
          if (by.size) {
            const list = el('ul', 'conn-what');
            for (const [a, n] of [...by].sort((x, y) => y[1] - x[1])) list.appendChild(el('li', null, `${LABEL[a] || a.replace(/_/g, ' ')}: ${n}`));
            u.appendChild(list);
          }
          if (t.names) {
            const seen = [];
            for (const r of done) if (r.detail && !seen.includes(r.detail)) seen.push(r.detail);
            if (seen.length) {
              const p = el('p', 'small');
              p.appendChild(el('b', null, 'Worked with: '));
              p.appendChild(document.createTextNode(seen.slice(0, 6).join(', ') + (seen.length > 6 ? ` and ${seen.length - 6} more` : '')));
              u.appendChild(p);
            }
          }
        }
        // connect / disconnect (these happen in Telegram for now)
        const m = els.manage;
        m.replaceChildren();
        if (t.connect) {
          m.appendChild(el('h2', null, 'Connect or disconnect'));
          const p1 = el('p', 'small', 'To connect, send this to your agent in Telegram. It replies with a link to approve in your browser.');
          m.appendChild(p1);
          const c1 = el('button', 'chip', t.connect); c1.type = 'button'; c1.dataset.copy = t.connect; m.appendChild(c1);
          if (t.hint) m.appendChild(el('p', 'small', t.hint));
          m.appendChild(el('p', 'small', 'To disconnect, send this. It removes the access your agent has saved.'));
          const c2 = el('button', 'chip', t.disconnect); c2.type = 'button'; c2.dataset.copy = t.disconnect; m.appendChild(c2);
          m.appendChild(el('p', 'muted small', 'This page can’t show whether an account is connected yet. Send /connections in Telegram to check.'));
        } else {
          m.appendChild(el('h2', null, 'Nothing to connect'));
          m.appendChild(el('p', 'small', 'This works as soon as you ask. Just tell your agent in Telegram what you want.'));
        }
        if (cfg.bot) {
          const a = el('a', 'btn small', 'Open in Telegram');
          a.href = `https://t.me/${cfg.bot}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
          const wrap = el('p', 'td-actions'); wrap.appendChild(a); m.appendChild(wrap);
        }
        bindCopy(m);
        // recent activity for this tool
        const body = els.rows;
        body.replaceChildren();
        for (const r of mine.slice(0, 15)) {
          const tr = el('tr');
          tr.appendChild(el('td', 'when', fmtWhen(r.ts)));
          const what = el('td', 'what');
          what.appendChild(el('b', null, labelFor(r)));
          if (t.names && r.detail && r.status === 'done') what.appendChild(el('span', 'detail', r.detail));
          tr.appendChild(what);
          const [text, cls] = STATUS[r.status] || [r.status || '—', 'other'];
          const res = el('td');
          res.appendChild(el('span', `badge b-${cls}`, text));
          tr.appendChild(res);
          body.appendChild(tr);
        }
        els.none.hidden = mine.length > 0;
        els.tbl.hidden = mine.length === 0;
      },
    };
    $('tools-refresh').addEventListener('click', () => tools.load());
    $('tool-back').addEventListener('click', () => show('tools'));

    // ---- chat: messages drop to the bottom like ChatGPT, with typing dots while the agent answers
    const chat = {
      busy: false, api: cfg.chatApi,
      key: null, list: [], currentId: null, fresh: true, needHistory: false,
      // Saved chats live only in THIS browser (never on a server), so the business's conversations stay private.
      loadList(userId) {
        this.key = `coop-chats-${userId}`;
        try { const a = JSON.parse(localStorage.getItem(this.key) || '[]'); this.list = Array.isArray(a) ? a.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.msgs)) : []; } catch { this.list = []; }
        this.renderList();
      },
      saveList() {
        this.list.sort((x, y) => y.at - x.at);
        this.list = this.list.slice(0, 40);
        try { localStorage.setItem(this.key, JSON.stringify(this.list)); } catch { /* storage full or blocked: chats just aren't kept */ }
      },
      renderList() {
        const box = $('chat-list');
        if (!box) return;
        box.replaceChildren();
        for (const c of this.list) {
          const row = el('div', `chatitem${c.id === this.currentId ? ' on' : ''}`);
          const open = el('button', 'chatopen', c.title); open.type = 'button'; open.title = c.title;
          open.addEventListener('click', () => this.open(c.id));
          const del = el('button', 'chatdel', '×'); del.type = 'button'; del.setAttribute('aria-label', `Delete chat: ${c.title}`);
          del.addEventListener('click', () => this.del(c.id));
          row.appendChild(open); row.appendChild(del); box.appendChild(row);
        }
      },
      current() { return this.list.find((c) => c.id === this.currentId) || null; },
      record(cls, text) {
        const c = this.current(); if (!c) return;
        c.msgs.push({ cls, text: String(text).slice(0, 4000) });
        c.msgs = c.msgs.slice(-200); c.at = Date.now();
        this.saveList(); this.renderList();
      },
      open(id) {
        if (this.busy) return;
        const c = this.list.find((x) => x.id === id); if (!c) return;
        $('chat-thread').replaceChildren();
        for (const m of c.msgs) this.add(m.cls, m.text);
        this.currentId = id; this.fresh = true; this.needHistory = true;
        this.renderList(); show('chat');
      },
      del(id) {
        if (this.busy) return;
        this.list = this.list.filter((c) => c.id !== id);
        this.saveList();
        if (id === this.currentId) this.reset(); else this.renderList();
      },
      init() {
        const input = $('chat-input'), send = $('chat-send');
        if (!this.api) {
          input.disabled = true; send.disabled = true;
          input.placeholder = 'Chat from this page isn’t switched on yet. Use Telegram for now.';
          return;
        }
        input.addEventListener('input', () => this.grow());
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); } });
        send.addEventListener('click', () => this.send());
      },
      grow() { const i = $('chat-input'); i.style.height = 'auto'; i.style.height = `${Math.min(i.scrollHeight, 180)}px`; },
      // Agent replies: plain text, except https links become real links and ``` fences become code blocks (never HTML).
      links(parent, str) {
        const parts = String(str).split(/(https:\/\/[^\s<>"]+)/);
        for (const part of parts) {
          const mm = /^(https:\/\/[^\s<>"]+?)([.,;:!?)\]]*)$/.exec(part);
          let ok = false;
          if (mm) { try { ok = new URL(mm[1]).protocol === 'https:'; } catch { ok = false; } }
          if (!ok) { if (part) parent.appendChild(document.createTextNode(part)); continue; }
          const a = el('a', 'msg-link', mm[1]);
          a.href = mm[1]; a.target = '_blank'; a.rel = 'noopener noreferrer';
          parent.appendChild(a);
          if (mm[2]) parent.appendChild(document.createTextNode(mm[2]));
        }
      },
      inline(parent, str) {
        for (const piece of String(str).split(/(`[^`\n]+`)/)) {
          if (/^`[^`\n]+`$/.test(piece)) parent.appendChild(el('code', 'msg-code', piece.slice(1, -1)));
          else this.links(parent, piece);
        }
      },
      codeBlock(parent, lang, code) {
        const box = el('div', 'codeblock');
        const head = el('div', 'codehead');
        head.appendChild(el('span', 'codelang', lang || 'code'));
        const copy = el('button', 'codecopy', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; }
          catch { copy.textContent = 'Press Ctrl+C'; const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
          setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
        });
        head.appendChild(copy);
        const pre = el('pre'); pre.appendChild(el('code', null, code));
        box.appendChild(head); box.appendChild(pre);
        parent.appendChild(box);
      },
      fill(m, text) {
        const s = String(text);
        const re = /```([\w+#.-]{0,20})[ \t]*\n?([\s\S]*?)(?:```|$)/g;
        let last = 0, mm;
        while ((mm = re.exec(s)) !== null) {
          const before = s.slice(last, mm.index).replace(/\n+$/, '');
          if (before) this.inline(m, before);
          this.codeBlock(m, mm[1], mm[2].replace(/\n+$/, ''));
          last = re.lastIndex;
          if (re.lastIndex >= s.length) break;
        }
        const rest = s.slice(last).replace(/^\n+/, '');
        if (rest) this.inline(m, rest);
      },
      // A file the agent made: offered as a download built in the browser from what the bot sent.
      file(f) {
        try {
          const name = String(f.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'file';
          const bin = atob(String(f.data || ''));
          if (bin.length > 4.5 * 1024 * 1024) return;
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const a = el('a', 'msg-file', `Download ${name}`);
          a.href = URL.createObjectURL(new Blob([bytes])); a.download = name;
          const m = this.add('agent'); m.appendChild(a);
        } catch { /* a broken file is skipped, the replies still show */ }
      },
      add(cls, text) {
        $('chat-hero').hidden = true; $('chat-thread').hidden = false; $('view-chat').classList.add('started');
        const m = el('div', `msg ${cls}`, cls === 'agent' ? '' : text);
        if (cls === 'agent' && text) this.fill(m, text);
        $('chat-thread').appendChild(m);
        $('chat-thread').scrollTop = $('chat-thread').scrollHeight;
        return m;
      },
      dots() {
        const m = this.add('agent');
        const t = el('span', 'typing');
        t.setAttribute('role', 'status'); t.setAttribute('aria-label', 'Your agent is typing');
        for (let i = 0; i < 3; i++) t.appendChild(el('span'));
        m.appendChild(t);
        return m;
      },
      reset() {
        if (this.busy) return;
        $('chat-thread').replaceChildren(); $('chat-thread').hidden = true; $('chat-hero').hidden = false;
        $('view-chat').classList.remove('started');
        this.currentId = null; this.fresh = true; this.needHistory = false; this.renderList();
      },
      async send() {
        const input = $('chat-input');
        const text = input.value.trim();
        if (this.busy || !text) return;
        input.value = ''; this.grow();
        this.busy = true; $('chat-send').disabled = true;
        if (!this.currentId) { // the first message starts a saved chat, titled with what was said
          const title = text.replace(/\s+/g, ' ').slice(0, 40) + (text.replace(/\s+/g, ' ').length > 40 ? '…' : '');
          this.currentId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          this.list.unshift({ id: this.currentId, title, at: Date.now(), msgs: [] });
        }
        const priorTurns = (this.current()?.msgs || []).filter((m) => m.cls === 'me' || m.cls === 'agent').slice(-8).map((m) => ({ role: m.cls === 'me' ? 'user' : 'assistant', text: m.text.slice(0, 300) }));
        const fresh = this.fresh, needHistory = this.needHistory;
        this.add('me', text); this.record('me', text);
        const dots = this.dots();
        try {
          const { data: s } = await db.auth.getSession();
          const token = s.session && s.session.access_token;
          if (!token) { dots.remove(); return sessionExpired(); }
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 90000);
          let res;
          try {
            res = await fetch(this.api, {
              method: 'POST', signal: ctl.signal,
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': '1' },
              body: JSON.stringify(fresh ? { message: text, fresh: true, ...(needHistory && priorTurns.length ? { history: priorTurns } : {}) } : { message: text }),
            });
          } finally { clearTimeout(timer); }
          if (res.status === 401) { dots.remove(); return sessionExpired(); }
          if (!res.ok) throw new Error(`status ${res.status}`);
          const out = await res.json();
          const replies = Array.isArray(out.replies) ? out.replies.map(String).filter(Boolean).slice(0, 10) : [];
          dots.remove();
          if (!replies.length && !(Array.isArray(out.files) && out.files.length)) this.add('agent', 'Done.');
          this.fresh = false; this.needHistory = false;
          for (const r of replies) { this.add('agent', r.slice(0, 4000)); this.record('agent', r.slice(0, 4000)); }
          for (const f of (Array.isArray(out.files) ? out.files.slice(0, 3) : [])) if (f && typeof f === 'object') this.file(f);
        } catch {
          dots.remove();
          this.add('err', 'Couldn’t reach your agent. Check that it’s running, then try again.');
        } finally {
          this.busy = false; $('chat-send').disabled = false; input.focus();
        }
      },
    };
    chat.init();
    chat.loadList(data.session.user.id);

    // ---- log charts: what the agent handled, and activity by day (counts only, built from metadata)
    const KINDS = [['chat', 'Chats', 's1'], ['action', 'Actions', 's2'], ['command', 'Commands', 's3'], ['blocked', 'Held back', 's4'], ['error', 'Errors', 's5']];
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const charts = {
      busy: false, rows: [],
      async load() {
        if (this.busy) return;
        this.busy = true;
        try {
          const { data: rows, error } = await db.from('agent_logs').select('ts,kind').order('id', { ascending: false }).limit(2000);
          if (error) throw error;
          this.rows = rows || [];
          this.render();
        } catch (e) {
          if (isAuthError(e)) return sessionExpired();
          $('charts').hidden = true;
        } finally { this.busy = false; }
      },
      render() {
        const rows = this.rows;
        $('charts').hidden = rows.length === 0;
        if (!rows.length) return;
        this.donut(rows);
        this.bars(rows);
        renderUsage($('usage-logs'));
      },
      donut(rows) {
        const counts = new Map(KINDS.map(([k]) => [k, 0]));
        for (const r of rows) if (counts.has(r.kind)) counts.set(r.kind, counts.get(r.kind) + 1);
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        $('kinds-sub').textContent = rows.length >= 2000 ? `Your latest ${total} entries.` : `${total} entries in total.`;
        const svg = $('donut'), legend = $('legend'), tbody = $('kinds-rows');
        svg.replaceChildren(); legend.replaceChildren(); tbody.replaceChildren();
        const R = 58, C = 2 * Math.PI * R;
        let offset = 0;
        for (const [kind, label, cls] of KINDS) {
          const n = counts.get(kind);
          if (!n) continue;
          const pct = Math.round((n / total) * 100);
          const len = (n / total) * C;
          const shown = len >= C - 0.01 ? C : Math.max(len - 2, 0.5); // a 2px gap between slices
          const c = svgEl('circle', { cx: 75, cy: 75, r: R, class: cls, 'stroke-dasharray': `${shown} ${C}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 75 75)' });
          const tip = `${label}: ${n} (${pct}%)`;
          c.addEventListener('mousemove', (e) => showTip(e, tip)); c.addEventListener('mouseleave', hideTip);
          svg.appendChild(c);
          offset += len;
          const li = el('li');
          li.appendChild(el('span', `sw ${cls}`));
          li.appendChild(el('span', null, label));
          li.appendChild(el('span', 'n', `${n} · ${pct}%`));
          li.addEventListener('mousemove', (e) => showTip(e, tip)); li.addEventListener('mouseleave', hideTip);
          legend.appendChild(li);
          const tr = el('tr'); tr.appendChild(el('td', null, label)); tr.appendChild(el('td', null, String(n))); tbody.appendChild(tr);
        }
        const big = svgEl('text', { x: 75, y: 80, 'text-anchor': 'middle', 'font-size': 26 }); big.textContent = String(total);
        const sub = svgEl('text', { x: 75, y: 97, 'text-anchor': 'middle', 'font-size': 10, class: 't-sub' }); sub.textContent = 'entries';
        svg.appendChild(big); svg.appendChild(sub);
      },
      bars(rows) {
        const DAYS = 14;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const days = [];
        for (let i = DAYS - 1; i >= 0; i--) { const d = new Date(today); d.setDate(today.getDate() - i); days.push({ d, key: dayKey(d), chat: 0, act: 0, bad: 0 }); }
        const byKey = new Map(days.map((x) => [x.key, x]));
        for (const r of rows) {
          const t = new Date(r.ts);
          if (Number.isNaN(t.getTime())) continue;
          const x = byKey.get(dayKey(t));
          if (!x) continue;
          if (r.kind === 'chat') x.chat++; else if (r.kind === 'action' || r.kind === 'command') x.act++; else x.bad++;
        }
        for (const x of days) x.total = x.chat + x.act + x.bad;
        const sum = days.reduce((a, x) => a + x.total, 0);
        $('days-sub').textContent = sum ? `Last ${DAYS} days. ${sum} in total.` : `Nothing in the last ${DAYS} days.`;
        const svg = $('bars');
        svg.replaceChildren();
        const W = Math.max(280, Math.round(svg.parentElement.clientWidth) || 560), H = 190;
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const L = 30, Rr = 6, T = 18, B = 28, pw = W - L - Rr, ph = H - T - B;
        const peak = Math.max(...days.map((x) => x.total), 0);
        const top = Math.max(4, peak <= 10 ? Math.ceil(peak / 2) * 2 : Math.ceil(peak / 5) * 5);
        const y = (v) => T + ph - (v / top) * ph;
        for (const v of [0, top / 2, top]) {
          svg.appendChild(svgEl('line', { x1: L, x2: W - Rr, y1: y(v), y2: y(v), class: 'grid' }));
          const lab = svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }); lab.textContent = String(Math.round(v)); svg.appendChild(lab);
        }
        const slot = pw / DAYS, bw = Math.max(8, Math.min(22, slot * 0.6));
        const labelEvery = slot < 30 ? 3 : 2;
        const tbody = $('days-rows'); tbody.replaceChildren();
        days.forEach((x, i) => {
          const cx = L + slot * i + slot / 2, bx = cx - bw / 2;
          const g = svgEl('g');
          g.appendChild(svgEl('rect', { x: L + slot * i, y: T, width: slot, height: ph, class: 'hit' }));
          const h = (x.total / top) * ph;
          if (h > 0) {
            const r = Math.min(3, h), yy = T + ph - h;
            g.appendChild(svgEl('path', { class: 'bar', d: `M${bx},${yy + h} L${bx},${yy + r} Q${bx},${yy} ${bx + r},${yy} L${bx + bw - r},${yy} Q${bx + bw},${yy} ${bx + bw},${yy + r} L${bx + bw},${yy + h} Z` }));
          }
          const when = x.d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          const tip = `${when}: ${x.total} (${x.chat} chat${x.chat === 1 ? '' : 's'}, ${x.act} action${x.act === 1 ? '' : 's'}, ${x.bad} held back or failed)`;
          g.addEventListener('mousemove', (e) => showTip(e, tip)); g.addEventListener('mouseleave', hideTip);
          svg.appendChild(g);
          if (i % labelEvery === (DAYS - 1) % labelEvery) {
            const lab = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'axis' }); lab.textContent = when; svg.appendChild(lab);
          }
          if (x.total === peak && peak > 0 && !days.slice(0, i).some((p) => p.total === peak)) {
            const v = svgEl('text', { x: cx, y: y(x.total) - 5, 'text-anchor': 'middle', class: 'val' }); v.textContent = String(x.total); svg.appendChild(v);
          }
          const tr = el('tr');
          for (const c of [when, x.chat, x.act, x.bad]) tr.appendChild(el('td', null, String(c)));
          tbody.insertBefore(tr, tbody.firstChild);
        });
      },
    };

    // ---- plan and credits. Read-only: only the bot (using its own key) ever writes plans and credits.
    // These numbers mirror plans.js on the bot and are placeholders until the pilot sets real ones. Once a month's
    // credits are granted, the ledger's own grant row is what counts, so a price change never rewrites history.
    const DAY_MS = 86400000;
    const PLAN_INFO = {
      trial: { label: 'Free trial', credits: null }, starter: { label: 'Starter', credits: 1000 }, pro: { label: 'Pro', credits: 3500 },
      business: { label: 'Business', credits: 9000 }, pilot: { label: 'Pilot', credits: 3500 }, frozen: { label: 'Paused', credits: null },
    };
    const TRIAL_DAYS = 30, GRACE_DAYS = 3, DAILY_FRACTION = 0.25, TRIAL_DAILY = { actions: 20, chats: 100 };
    const CONTACT = 'cooptech126@gmail.com';
    const ymd = (t) => new Date(t).toISOString().slice(0, 10);
    const dayText = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
    const num = (n) => Number(n).toLocaleString('en-US');
    // The billing cycle is monthly from the anchor's day-of-month (short months clamp), in UTC. Same rule as the bot.
    function cycleStartOf(anchor, now) {
      const a0 = new Date(`${String(anchor).slice(0, 10)}T00:00:00Z`);
      if (Number.isNaN(a0.getTime())) return null;
      const day = a0.getUTCDate();
      const pick = (y, m) => new Date(Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())));
      let start = pick(now.getUTCFullYear(), now.getUTCMonth());
      if (start.getTime() > now.getTime()) start = pick(now.getUTCFullYear(), now.getUTCMonth() - 1);
      if (start.getTime() < a0.getTime()) start = a0;
      return ymd(start);
    }
    const nextCycleOf = (anchor, cycle) => cycleStartOf(anchor || cycle, new Date(new Date(`${cycle}T00:00:00Z`).getTime() + 32 * DAY_MS));
    // What this login is allowed to do right now (same rules as the bot's entitlement check).
    function deriveAccount(row, nowMs) {
      const key = String(row.plan || '');
      const info = PLAN_INFO[key];
      const ends = row.ends_at ? new Date(row.ends_at).getTime() : null;
      const base = { key, label: info ? info.label : 'Unknown', endsAt: ends ? new Date(ends).toISOString() : null, anchor: row.cycle_anchor ? String(row.cycle_anchor).slice(0, 10) : null };
      if (key === 'frozen') return { ...base, state: 'frozen', reason: 'manual' };
      if (!info) return { ...base, state: 'frozen', reason: 'unknown' };
      if (key === 'trial') {
        const started = row.created_at ? new Date(row.created_at).getTime() : (ends ? ends - TRIAL_DAYS * DAY_MS : nowMs);
        const over = ends != null && nowMs >= ends;
        return { ...base, state: over ? 'frozen' : 'trial', reason: over ? 'trial_ended' : null, daysLeft: ends == null ? null : Math.max(0, Math.ceil((ends - nowMs) / DAY_MS)), day: Math.min(TRIAL_DAYS, Math.max(0, Math.floor((nowMs - started) / DAY_MS)) + 1) };
      }
      if (key === 'pilot') { const over = ends != null && nowMs >= ends; return { ...base, state: over ? 'frozen' : 'pilot', reason: over ? 'pilot_ended' : null, metered: true, planCredits: info.credits }; }
      const lapsed = ends != null && nowMs >= ends + GRACE_DAYS * DAY_MS;
      return { ...base, state: lapsed ? 'frozen' : 'active', reason: lapsed ? 'lapsed' : null, metered: true, planCredits: info.credits };
    }
    const account = {
      info: null, at: 0, loading: null,
      async load(force) {
        if (!force && this.at && Date.now() - this.at < 30000) return this.info;
        if (this.loading) return this.loading;
        this.loading = (async () => {
          try {
            const { data: rows, error } = await db.from('tenant_plans').select('plan,ends_at,cycle_anchor,created_at').limit(1);
            if (error) { if (isAuthError(error)) { sessionExpired(); return this.info; } throw error; }
            const row = rows && rows[0];
            if (!row) { this.info = { state: 'none' }; }
            else {
              const info = deriveAccount(row, Date.now());
              if (info.metered) {
                info.cycle = cycleStartOf(info.anchor || row.created_at, new Date());
                info.reset = info.cycle ? nextCycleOf(info.anchor, info.cycle) : null;
                try {
                  const { data: led, error: lerr } = await db.from('credit_ledger').select('ts,delta,reason').eq('cycle', info.cycle).limit(5000);
                  if (lerr) { if (isAuthError(lerr)) { sessionExpired(); return this.info; } throw lerr; }
                  const midnight = new Date(`${ymd(Date.now())}T00:00:00Z`).getTime();
                  let left = 0, total = 0, today = 0, granted = false;
                  for (const r of led || []) {
                    const d = Number(r.delta) || 0; left += d;
                    if (r.reason === 'spend') { if (new Date(r.ts).getTime() >= midnight) today += -d; }
                    else if (r.reason === 'refund') { if (new Date(r.ts).getTime() >= midnight) today -= d; }
                    else { total += d; if (r.reason === 'grant') granted = true; }
                  }
                  if (!granted) { total += info.planCredits; left += info.planCredits; } // the grant is written with the first message of the cycle
                  info.credits = { total, left, used: total - left, today: Math.max(0, today), daily: Math.floor(info.planCredits * DAILY_FRACTION) };
                } catch { info.credits = null; info.creditsFailed = true; }
              }
              this.info = info;
            }
          } catch { this.info = null; } // couldn't read it: the page quietly keeps its simpler view
          this.at = Date.now();
          return this.info;
        })();
        try { return await this.loading; } finally { this.loading = null; }
      },
      pausedText(a) {
        const when = a.endsAt ? ` on ${dayText(a.endsAt)}` : '';
        if (a.reason === 'trial_ended') return `Your free trial ended${when}, so your agent is paused. It can’t chat or do work until you choose a plan. Your data is safe. Email ${CONTACT} to switch it back on.`;
        if (a.reason === 'pilot_ended') return `Your pilot ended${when}, so your agent is paused. Your data is safe. Email ${CONTACT} to switch it back on.`;
        if (a.reason === 'lapsed') return `Your plan’s payment period ended${when}, so your agent is paused. Your data is safe. Email ${CONTACT} to switch it back on.`;
        return `Your agent is paused right now. Your data is safe. Email ${CONTACT} and we’ll switch it back on.`;
      },
      // The strip at the top of every page: paused, or a trial that is about to end.
      banner() {
        const a = this.info; const b = $('paused-banner');
        let text = '', kind = '';
        if (a && a.state === 'frozen') { text = this.pausedText(a); kind = 'bad'; }
        else if (a && a.state === 'trial' && a.daysLeft != null && a.daysLeft <= 5) {
          text = `Your free trial ends ${a.daysLeft <= 0 ? 'today' : a.daysLeft === 1 ? 'tomorrow' : `in ${a.daysLeft} days`} (${dayText(a.endsAt)}). After that your agent pauses until you choose a plan. Email ${CONTACT} to keep it running.`; kind = 'warn';
        }
        b.textContent = text; b.className = `notice${kind ? ` ${kind}` : ''}`; b.hidden = !text;
        if (a && a.state === 'frozen' && chat.api) { // nothing to send to a paused agent
          const input = $('chat-input'); input.disabled = true; $('chat-send').disabled = true; input.placeholder = 'Your agent is paused. See the notice at the top of the page.';
        }
      },
    };

    // The plan card in Settings. Left as the simple built-in text when the plan can't be read.
    function renderPlanCard() {
      const a = account.info; const card = $('plan-card');
      if (!card || !a) return;
      card.replaceChildren();
      if (a.state === 'none') {
        card.appendChild(el('strong', null, 'Free trial'));
        card.appendChild(el('p', 'muted small tight', 'Your 30-day free trial starts with your first message to your agent. Nothing is charged.'));
        return;
      }
      card.appendChild(el('strong', null, `${a.label} `));
      const badge = { trial: ['b-asked', 'Trial'], active: ['b-done', 'Active'], pilot: ['b-done', 'Pilot'], frozen: ['b-failed', 'Paused'] }[a.state];
      if (badge) card.appendChild(el('span', `badge ${badge[0]}`, badge[1]));
      const line = (t) => card.appendChild(el('p', 'muted small tight', t));
      if (a.state === 'frozen') line(account.pausedText(a));
      else if (a.state === 'trial') line(`${a.daysLeft == null ? 'No end date set.' : `${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left (ends ${dayText(a.endsAt)}).`} Full use of the larger model, with daily limits of ${TRIAL_DAILY.actions} actions and ${TRIAL_DAILY.chats} chats. Nothing is charged.`);
      else if (a.state === 'pilot') line(`You’re in the co|op pilot. Nothing is charged.${a.endsAt ? ` Your pilot runs until ${dayText(a.endsAt)}.` : ' There’s no end date set.'} We’ll email you well before any paid plan starts.`);
      else line(a.endsAt ? `Paid through ${dayText(a.endsAt)}.` : 'Active.');
      if (a.credits) line(`${num(Math.max(0, a.credits.left))} of ${num(a.credits.total)} credits left this month. They reset on ${dayText(a.reset)}.`);
      else if (a.creditsFailed) line('We couldn’t load your credits just now. Refresh in a moment.');
    }

    // ---- usage: draws one bar. Credits when the plan has them; days for a trial; otherwise a request count.
    function usageNow() {
      const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
      const rows = charts.rows;
      let used = 0;
      for (const r of rows) { if ((r.kind === 'chat' || r.kind === 'action') && new Date(r.ts) >= start) used++; }
      const oldest = rows.length ? new Date(rows[rows.length - 1].ts) : null;
      const partial = rows.length >= 2000 && oldest && oldest >= start; // more rows than we load, so the count may be low
      return { used, partial };
    }
    function drawUsage(box, { title, strong, rest, ratio, now, max, noteText, extra, wordFor }) {
      const level = ratio >= 1 ? 'red' : ratio >= 0.8 ? 'yellow' : ratio >= 0.5 ? 'green' : 'blue';
      const word = (wordFor || { blue: 'Plenty left', green: 'On track', yellow: 'Running low', red: 'Allowance used up' })[level];
      box.replaceChildren();
      box.className = box.className.replace(/\bu-(blue|green|yellow|red)\b/g, '').trim() + ` u-${level}`;
      box.appendChild(el('h2', null, title));
      const head = el('div', 'usage-head');
      const big = el('span');
      big.appendChild(el('strong', null, strong));
      big.appendChild(document.createTextNode(rest));
      head.appendChild(big);
      head.appendChild(el('span', 'u-pill', word));
      box.appendChild(head);
      const track = el('div', 'u-track');
      track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(max));
      track.setAttribute('aria-valuenow', String(Math.min(now, max))); track.setAttribute('aria-label', `${title}: ${word}`);
      const fill = el('div', 'u-fill'); fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
      track.appendChild(fill); box.appendChild(track);
      const key = el('ul', 'u-key');
      for (const [c, t] of [['var(--u-blue)', 'Under half'], ['var(--u-green)', '50% to 79%'], ['var(--u-yellow)', '80% or more, running low'], ['var(--u-red)', 'Used up']]) {
        const li = el('li'); const i = el('i'); i.style.background = c; li.appendChild(i); li.appendChild(document.createTextNode(t)); key.appendChild(li);
      }
      box.appendChild(key);
      for (const t of [noteText, extra]) if (t) box.appendChild(el('p', 'muted small', t));
    }
    function renderUsage(box) {
      if (!box) return;
      const a = account.info;
      if (a && a.state === 'frozen') {
        box.replaceChildren(el('h2', null, 'Usage this month'), el('p', 'muted small', 'Your agent is paused, so nothing is being used. See the notice at the top of the page.'));
        return;
      }
      if (a && a.metered && a.credits) {
        const c = a.credits; const ratio = c.total > 0 ? c.used / c.total : 0;
        drawUsage(box, {
          title: 'Credits this month', strong: num(Math.max(0, c.used)), rest: ` of ${num(c.total)} credits · ${Math.round(ratio * 100)}%`, ratio, now: c.used, max: c.total || 1,
          noteText: `Credits reset on ${dayText(a.reset)} and don’t carry over. An action costs 5 credits, chat on the larger model costs 2, and chat on the smaller model is free.`,
          extra: `Today: ${num(c.today)} of ${num(c.daily)} (a daily limit keeps the month’s credits from running out in one day). Need more? Email ${CONTACT}.`,
          wordFor: { blue: 'Plenty left', green: 'On track', yellow: 'Running low', red: 'Credits used up' },
        });
        return;
      }
      if (a && a.state === 'trial') {
        drawUsage(box, {
          title: 'Free trial', strong: `Day ${a.day}`, rest: ` of ${TRIAL_DAYS}`, ratio: a.day / TRIAL_DAYS, now: a.day, max: TRIAL_DAYS,
          noteText: `Full use of the larger model during the trial, with daily limits of ${TRIAL_DAILY.actions} actions and ${TRIAL_DAILY.chats} chats. After day ${TRIAL_DAYS} your agent pauses until you choose a plan.`,
          wordFor: { blue: 'Just started', green: 'Halfway', yellow: 'Ending soon', red: 'Trial over' },
        });
        return;
      }
      if (a && a.metered && a.creditsFailed) {
        box.replaceChildren(el('h2', null, 'Credits this month'), el('p', 'muted small', 'We couldn’t load your credits just now. Refresh in a moment.'));
        return;
      }
      const limit = cfg.usageLimit, { used, partial } = usageNow();
      drawUsage(box, {
        title: 'Usage this month', strong: `${partial ? 'at least ' : ''}${used}`, rest: ` of ${limit} requests · ${Math.round((used / limit) * 100)}%`, ratio: used / limit, now: used, max: limit,
        noteText: `Counts your chats and actions since the 1st. The ${limit}-request allowance is a pilot placeholder and nothing is switched off if you pass it.`,
      });
    }

    // ---- settings: details, appearance, plan and billing, usage, password
    const settings = {
      pane: 'profile', wired: false,
      meta() { return (data.session.user.user_metadata) || {}; },
      say(id, text, ok) { const m = $(id); m.textContent = text; m.className = `set-msg ${ok ? 'ok-note' : 'error'}`; m.hidden = !text; },
      fillProfile() {
        const m = this.meta();
        $('set-name').value = m.full_name || '';
        $('set-email').value = data.session.user.email || '';
        const biz = $('agent-sub').textContent.replace(/^Your agent( for )?/, '');
        $('set-biz').value = biz || m.business_name || '';
        const b = m.billing || {};
        $('bill-name').value = b.name || ''; $('bill-company').value = b.company || ''; $('bill-email').value = b.email || ''; $('bill-address').value = b.address || '';
        this.say('profile-msg', ''); this.say('billing-msg', ''); this.say('pw-msg', '');
      },
      themeUi() {
        const cur = window.coopTheme ? window.coopTheme.get() : 'dark';
        for (const b of document.querySelectorAll('[data-theme-opt]')) b.setAttribute('aria-checked', String(b.dataset.themeOpt === cur));
      },
      go(p) {
        this.pane = p;
        for (const b of document.querySelectorAll('.set-nav [data-set]')) { if (b.dataset.set === p) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
        for (const x of document.querySelectorAll('.set-pane')) x.hidden = x.id !== `set-${p}`;
        if (p === 'plan') account.load(true).then(() => renderPlanCard());
        if (p === 'usage') this.usage();
      },
      async usage() {
        const box = $('usage-set');
        if (linked !== true) { box.replaceChildren(el('p', 'muted small', 'Usage shows up once your agent is linked. Open Get started to link it.')); return; }
        await Promise.all([charts.load(), account.load(true)]);
        renderUsage(box);
      },
      open() { this.fillProfile(); this.themeUi(); this.go(this.pane); if (!this.wired) this.wire(); },
      async update(payload, msgId, okText) {
        try {
          const { data: res, error } = await db.auth.updateUser(payload);
          if (error) throw error;
          if (res && res.user) data.session.user.user_metadata = res.user.user_metadata || data.session.user.user_metadata;
          this.say(msgId, okText, true);
          return true;
        } catch (e) {
          if (isAuthError(e)) { sessionExpired(); return false; }
          const code = e && (e.code || e.error_code);
          this.say(msgId, code === 'same_password' ? 'That is already your password. Pick a new one.'
            : code === 'weak_password' ? 'That password is too easy to guess. Use a longer one with letters and numbers.'
            : "Couldn't save that. Try again in a moment.", false);
          return false;
        }
      },
      wire() {
        this.wired = true;
        for (const b of document.querySelectorAll('.set-nav [data-set]')) b.addEventListener('click', () => this.go(b.dataset.set));
        for (const b of document.querySelectorAll('[data-theme-opt]')) b.addEventListener('click', () => { if (window.coopTheme) window.coopTheme.set(b.dataset.themeOpt); this.themeUi(); });
        $('profile-cancel').addEventListener('click', () => this.fillProfile());
        $('profile-save').addEventListener('click', async () => {
          const name = $('set-name').value.trim();
          if (name.length > 80) return this.say('profile-msg', 'That name is too long.', false);
          const btn = $('profile-save'); btn.disabled = true;
          await this.update({ data: { full_name: name } }, 'profile-msg', 'Saved.');
          btn.disabled = false;
        });
        $('billing-save').addEventListener('click', async () => {
          const email = $('bill-email').value.trim();
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return this.say('billing-msg', 'Enter a valid billing email, or leave it blank.', false);
          const billing = { name: $('bill-name').value.trim(), company: $('bill-company').value.trim(), email, address: $('bill-address').value.trim() };
          const btn = $('billing-save'); btn.disabled = true;
          await this.update({ data: { billing } }, 'billing-msg', 'Saved.');
          btn.disabled = false;
        });
        $('pw-save').addEventListener('click', async () => {
          const a = $('pw-new').value, b = $('pw-again').value;
          if (a.length < 8) return this.say('pw-msg', 'Use at least 8 characters.', false);
          if (a !== b) return this.say('pw-msg', 'The two passwords don’t match.', false);
          const btn = $('pw-save'); btn.disabled = true;
          const ok = await this.update({ password: a }, 'pw-msg', 'Password updated.');
          if (ok) { $('pw-new').value = ''; $('pw-again').value = ''; }
          btn.disabled = false;
        });
        $('signout-all').addEventListener('click', async () => { try { await db.auth.signOut({ scope: 'global' }); } finally { goLogin(); } });
      },
    };
    let resizeT = null;
    window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (charts.rows.length && view === 'logs') charts.bars(charts.rows); }, 150); });

    // ---- get started: install Telegram -> open the agent -> connect tools -> try it
    const STEPS = ['telegram', 'agent', 'connect', 'try'];
    const stepKey = `coop-start-${data.session.user.id}`;
    let stepsDone = [];
    try { stepsDone = JSON.parse(localStorage.getItem(stepKey) || '[]').filter((s) => STEPS.includes(s)); } catch { stepsDone = []; }
    function renderSteps() {
      let current = STEPS.find((s) => !stepsDone.includes(s)) || null;
      for (const s of STEPS) {
        const card = $(`step-${s}`);
        const done = stepsDone.includes(s);
        card.classList.toggle('done', done);
        card.classList.toggle('locked', !done && s !== current);
        card.querySelector('.step-body').hidden = !(s === current);
        card.querySelector('.step-state').textContent = done ? 'Done' : s === current ? 'Now' : 'Next';
      }
      $('start-finished').hidden = current !== null;
    }
    function markStep(s) {
      if (!stepsDone.includes(s)) stepsDone.push(s);
      try { localStorage.setItem(stepKey, JSON.stringify(stepsDone)); } catch { /* ignore */ }
      renderSteps();
    }
    for (const b of document.querySelectorAll('[data-step-done]')) b.addEventListener('click', () => markStep(b.dataset.stepDone));
    $('steps-reset').addEventListener('click', () => { stepsDone = []; try { localStorage.removeItem(stepKey); } catch { /* ignore */ } renderSteps(); });
    $('go-logs').addEventListener('click', () => show('logs'));
    $('go-help').addEventListener('click', () => show('help'));
    bindCopy(document);
    renderSteps();

    // ---- approval + personal link (Get started, step 2)
    let signupStatus = null;   // 'pending' | 'approved' | 'denied' | 'none' | null (not known yet)
    let signupName = '';
    let linkCode = '';          // the one-time code behind the personal link, while it's valid
    let linkBusy = false;
    let checkFailed = false;
    const tgLink = document.querySelector('.tg-link');
    function setNotice(text, kind) {
      const n = $('notice');
      n.textContent = text || '';
      n.className = `notice${kind ? ` ${kind}` : ''}`;
      n.hidden = !text;
    }
    function renderLinkState() {
      const isLinked = linked === true;
      const s = signupStatus;
      const haveLink = !isLinked && s === 'approved' && Boolean(linkCode);
      let intro;
      if (isLinked) intro = 'This opens your agent in Telegram. Tap Start at the bottom.';
      else if (checkFailed) intro = 'We couldn’t check your sign-up just now. Refresh this page in a moment.';
      else if (s === 'pending') intro = 'Your request is waiting for approval. When you’re approved, your personal link appears here. This page checks for you.';
      else if (s === 'denied') intro = 'Your request wasn’t approved, so there’s no link.';
      else if (s === 'none') intro = 'We don’t have a sign-up request for this login. Email cooptech126@gmail.com and we’ll sort it out.';
      else if (s === 'approved') intro = 'You’re approved. Tap the button, then press Start in Telegram. That ties this login to your own agent.';
      else intro = 'Checking your sign-up…';
      $('agent-intro').textContent = intro;
      tgLink.hidden = !(cfg.bot && (isLinked || haveLink));
      $('link-note').hidden = !haveLink;
      $('link-wait').hidden = !haveLink;
      $('agent-ok').hidden = !isLinked;
      $('no-bot').hidden = Boolean(cfg.bot);
      if (cfg.bot) {
        tgLink.href = haveLink ? `https://t.me/${cfg.bot}?start=link_${linkCode}` : `https://t.me/${cfg.bot}`;
      }
      if (!isLinked && !checkFailed && s === 'pending') setNotice('Thanks! We’re reviewing your request. This page will update on its own when you’re approved.', 'warn');
      else if (!isLinked && s === 'denied') setNotice('Your request wasn’t approved. If you think that’s a mistake, email cooptech126@gmail.com.', 'bad');
      else if (!isLinked) setNotice('');
    }
    async function makeLink() {
      if (linkBusy || linked !== false || signupStatus !== 'approved') return;
      linkBusy = true;
      $('link-err').hidden = true;
      try {
        const { data: code, error } = await db.rpc('create_link_code');
        if (error) throw error;
        linkCode = typeof code === 'string' && /^[a-f0-9]{32}$/.test(code) ? code : ''; // only ever put a plain code in a link
        if (!linkCode && code) throw new Error('bad code');
      } catch (e) {
        if (isAuthError(e)) { sessionExpired(); return; }
        linkCode = '';
        $('link-err').textContent = 'Couldn’t make your link. Refresh this page in a moment.';
        $('link-err').hidden = false;
      } finally {
        linkBusy = false;
        renderLinkState();
      }
    }
    async function refreshSignup() {
      const { data: rows, error } = await db.from('signups').select('status,business_name').limit(1);
      if (error) {
        if (isAuthError(error)) { sessionExpired(); return; }
        checkFailed = true;
        return;
      }
      checkFailed = false;
      const row = rows && rows[0];
      signupStatus = row ? row.status : 'none';
      signupName = row && row.business_name && row.business_name !== '(existing login)' ? row.business_name : '';
      if (signupStatus === 'approved' && !linkCode) await makeLink();
    }
    $('new-link').addEventListener('click', () => { linkCode = ''; makeLink(); });
    $('go-start').addEventListener('click', () => show('start'));

    // While this login isn't linked yet, quietly watch for approval and for the moment the link is used.
    let watchTimer = null;
    function startWatch() {
      if (linked !== false || watchTimer) return;
      let ticks = 0;
      watchTimer = setInterval(async () => {
        if (document.visibilityState !== 'visible' || ++ticks > 720) return; // about an hour of watching, then stop
        try {
          const { data: l, error } = await db.from('tenant_users').select('chat_id').limit(1);
          if (error) { if (isAuthError(error)) sessionExpired(); return; }
          if (l && l.length) {
            clearInterval(watchTimer); watchTimer = null;
            linked = true; linkCode = '';
            $('agent-sub').textContent = signupName ? `Your agent for ${signupName}` : 'Your agent';
            $('chat-sub').textContent = $('agent-sub').textContent;
            markStep('agent');
            setNotice('✅ Linked! Your agent is connected to this login. Next, connect your tools.', 'good');
            renderLinkState();
            show(view);
            return;
          }
          const before = signupStatus;
          await refreshSignup();
          if (before !== signupStatus || !linkCode) renderLinkState();
        } catch (e) { if (isAuthError(e)) sessionExpired(); }
      }, 5000);
    }

    // ---- is this login linked to an agent?
    try {
      const { data: link, error } = await db.from('tenant_users').select('chat_id').limit(1);
      if (error) throw error;
      linked = Array.isArray(link) && link.length > 0;
      let hasLogs = false, logsFailed = false;
      if (linked) {
        const { data: last, error: lastErr } = await db.from('agent_logs').select('business').order('id', { ascending: false }).limit(1);
        if (lastErr && isAuthError(lastErr)) return sessionExpired();
        logsFailed = Boolean(lastErr);
        hasLogs = Boolean(last && last.length) || logsFailed;
        let name = last && last[0] && last[0].business;
        if (!name) {
          const { data: su } = await db.from('signups').select('business_name').limit(1);
          const n = su && su[0] && su[0].business_name;
          if (n && n !== '(existing login)') name = n;
        }
        $('agent-sub').textContent = name ? `Your agent for ${name}` : 'Your agent';
        $('chat-sub').textContent = $('agent-sub').textContent;
      } else {
        await refreshSignup();
      }
      if (linked) { await account.load(true); account.banner(); renderPlanCard(); }
      if (!view) view = linked && hasLogs ? (logsFailed ? 'logs' : 'chat') : 'start'; // an active agent lands on Chat (Logs if they can't load, so the message shows); new or unlinked accounts start at Get started
      renderLinkState();
    } catch (e) {
      if (isAuthError(e)) return sessionExpired();
      linked = null;
      $('unlinked').querySelector('h2').textContent = "Couldn't check your account";
      $('unlinked').querySelector('p').textContent = 'Refresh the page in a moment. If it keeps happening, email us at the address below.';
      $('unlinked').hidden = false;
      return;
    }
    show(view);
    startWatch();
  }

  // ---- start ------------------------------------------------------------------------------
  const cfg = readConfig();
  if (cfg.error) return showFatal(cfg.error);
  if (!window.supabase || !window.supabase.createClient) return showFatal('The site could not load its login library. Refresh the page.');
  const db = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  if (page === 'login') bootLogin(db);
  else if (page === 'dashboard') bootDashboard(db, cfg);
})();
