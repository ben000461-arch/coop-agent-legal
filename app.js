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
    return { url, key, bot };
  }

  // ---- login and sign-up ------------------------------------------------------------------
  async function bootLogin(db) {
    const { data } = await db.auth.getSession();
    if (data.session) return location.replace('dashboard.html');

    const form = $('form');
    const err = $('err');
    const go = $('go');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    let mode = 'login';

    function setMode(m) {
      mode = m;
      const su = m === 'signup';
      $('signup-fields').hidden = !su;
      $('sub').textContent = su ? 'Create an account. We review every request before an agent is set up.' : 'Log in to see what your agent has been doing.';
      go.textContent = su ? 'Create account' : 'Log in';
      $('password').autocomplete = su ? 'new-password' : 'current-password';
      $('toggle-text').textContent = su ? 'Already have an account?' : 'New here?';
      $('toggle').textContent = su ? 'Log in' : 'Create an account';
      err.hidden = true;
    }
    $('toggle').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
    $('back-login').addEventListener('click', () => { $('done').hidden = true; form.hidden = false; $('toggle').parentElement.hidden = false; setMode('login'); });
    if (location.hash === '#signup') setMode('signup');

    // Coming back from the confirmation email: the address carries tokens we don't use. Remove them from
    // the address bar and say what happened. (Nothing is stored; the person logs in normally.)
    const h = location.hash;
    if (/access_token=|type=signup|error_description=|error_code=/.test(h)) {
      try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
      const note = $('note');
      if (/error_description=|error_code=/.test(h)) note.textContent = 'That confirmation link didn’t work, or it has expired. Try creating the account again, or log in if you already have one.';
      else note.textContent = 'Your email is confirmed. Log in to continue.';
      note.hidden = false;
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
      else if (error.status === 400 || error.status === 401 || error.status === 422) fail("That email and password didn't match.");
      else fail("Couldn't reach the server. Check your connection and try again.");
    }

    async function doSignup(email, password) {
      const use_case = $('use_case').value;
      const business_type = $('business_type').value.trim();
      const business_name = $('business_name').value.trim();
      const notes = $('notes').value.trim();
      if (password.length < 8) return fail('Use a password with at least 8 characters.');
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
      if (!email || !password) return fail('Enter your email and password.');
      if (mode === 'login') {
        go.disabled = true;
        go.textContent = 'Logging in…';
        return doLogin(email, password);
      }
      return doSignup(email, password);
    });
  }

  // ---- dashboard --------------------------------------------------------------------------
  const LABEL = {
    add: 'Added two numbers', multiply: 'Multiplied two numbers', weather: 'Looked up the weather',
    add_note: 'Saved a note', list_notes: 'Read back your notes', list_events: 'Checked your calendar',
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
    const VIEWS = ['start', 'agent', 'connections', 'logs', 'help'];
    const NEEDS_AGENT = new Set(['agent', 'connections', 'logs']); // Get started and Help work for anyone
    const fromHash = location.hash.slice(1);
    let view = VIEWS.includes(fromHash) ? fromHash : null; // chosen after we know if the login is linked
    let linked = null; // null = not known yet
    function show(v) {
      view = v;
      try { history.replaceState(null, '', `#${v}`); } catch { /* ignore */ }
      for (const b of document.querySelectorAll('.side button')) {
        if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      }
      const blocked = NEEDS_AGENT.has(v) && linked === false;
      $('unlinked').hidden = !blocked;
      for (const name of VIEWS) {
        const open = name === v && (!NEEDS_AGENT.has(name) || linked === true);
        $(`view-${name}`).hidden = !open;
      }
      if (v === 'logs' && linked === true && !logs.started) logs.start();
      if (v === 'connections' && linked === true) conns.load();
    }
    for (const b of document.querySelectorAll('.side button')) b.addEventListener('click', () => show(b.dataset.view));

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
      start() { this.started = true; this.reload(); setInterval(() => { if (document.visibilityState === 'visible' && view === 'logs') this.fresh(); }, REFRESH_MS); },
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
    $('refresh').addEventListener('click', () => logs.fresh());
    $('older').addEventListener('click', () => logs.older());

    // ---- connections: what each connected tool has done (counts and names only, from the log)
    const CONNS = [
      { name: 'Google Calendar', blurb: 'Reads your calendar to answer questions. It never changes events.', actions: ['list_events'] },
      { name: 'Gmail', blurb: 'Saves email drafts for you to look over. It never sends email and never reads your inbox.', actions: ['draft_email'] },
      { name: 'GitHub', blurb: 'Looks at the projects you chose, and only after your yes puts a change on a new branch as a pull request.', actions: ['list_repos', 'list_prs', 'build_status', 'code_task', 'cloud_ok', 'push_change'], names: true },
      { name: 'Files and spreadsheets', blurb: 'Files and spreadsheets the agent makes for you.', actions: ['write_file', 'write_excel', 'view_excel', 'edit_excel'], names: true },
      { name: 'Notes', blurb: 'Quick notes you ask it to keep.', actions: ['add_note', 'list_notes'] },
    ];
    const conns = {
      busy: false, loaded: false,
      async load() {
        if (this.busy) return;
        this.busy = true;
        const err = $('conn-err');
        err.hidden = true;
        try {
          const { data: rows, error } = await db.from('agent_logs').select('ts,kind,action,status,detail')
            .neq('kind', 'chat').order('id', { ascending: false }).limit(1000);
          if (error) throw error;
          this.render(rows || []);
          this.loaded = true;
          $('conn-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        } catch (e) {
          if (isAuthError(e)) return sessionExpired();
          err.textContent = "Couldn't load your connections. Try Refresh in a moment.";
          err.hidden = false;
        } finally { this.busy = false; }
      },
      render(rows) {
        const box = $('conn-list');
        box.replaceChildren();
        for (const c of CONNS) {
          const mine = rows.filter((r) => c.actions.includes(r.action));
          const done = mine.filter((r) => r.status === 'done');
          const failed = mine.filter((r) => r.status === 'failed').length;
          const card = el('article', 'conn');
          card.appendChild(el('h2', null, c.name));
          card.appendChild(el('p', 'muted small', c.blurb));
          if (!done.length && !failed) {
            card.appendChild(el('p', 'conn-none', 'Not used yet.'));
            box.appendChild(card);
            continue;
          }
          const big = el('p', 'conn-count');
          big.appendChild(el('strong', null, String(done.length)));
          big.appendChild(document.createTextNode(done.length === 1 ? ' time used' : ' times used'));
          if (failed) big.appendChild(el('span', 'badge b-failed', `${failed} failed`));
          card.appendChild(big);
          if (done.length) card.appendChild(el('p', 'muted small', `Last used ${fmtWhen(done[0].ts)}`));
          const by = new Map();
          for (const r of done) by.set(r.action, (by.get(r.action) || 0) + 1);
          if (by.size) {
            const ul = el('ul', 'conn-what');
            for (const [a, n] of [...by].sort((x, y) => y[1] - x[1])) ul.appendChild(el('li', null, `${LABEL[a] || a.replace(/_/g, ' ')}: ${n}`));
            card.appendChild(ul);
          }
          if (c.names) {
            const seen = [];
            for (const r of done) if (r.detail && !seen.includes(r.detail)) seen.push(r.detail);
            if (seen.length) {
              const t = el('p', 'small');
              t.appendChild(el('b', null, 'Worked with: '));
              t.appendChild(document.createTextNode(seen.slice(0, 6).join(', ') + (seen.length > 6 ? ` and ${seen.length - 6} more` : '')));
              card.appendChild(t);
            }
          }
          box.appendChild(card);
        }
        $('conn-note').hidden = false;
      },
    };
    $('conn-refresh').addEventListener('click', () => conns.load());

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
    for (const b of document.querySelectorAll('[data-copy]')) {
      b.addEventListener('click', async () => {
        const old = b.dataset.label || (b.dataset.label = b.textContent);
        try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy it by hand'; }
        setTimeout(() => { b.textContent = old; }, 1500);
      });
    }
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
      let hasLogs = false;
      if (linked) {
        const { data: last, error: lastErr } = await db.from('agent_logs').select('business').order('id', { ascending: false }).limit(1);
        if (lastErr && isAuthError(lastErr)) return sessionExpired();
        let name = last && last[0] && last[0].business;
        hasLogs = Boolean(last && last.length) || Boolean(lastErr); // on an error, open Logs so the message shows
        if (!name) {
          const { data: su } = await db.from('signups').select('business_name').limit(1);
          const n = su && su[0] && su[0].business_name;
          if (n && n !== '(existing login)') name = n;
        }
        $('agent-sub').textContent = name ? `Your agent for ${name}` : 'Your agent';
      } else {
        await refreshSignup();
      }
      if (!view) view = linked && hasLogs ? 'logs' : 'start'; // new or unlinked accounts start at Get started
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
