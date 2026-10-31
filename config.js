// Public settings for the website. Everything here is visible to anyone who opens the site,
// so it holds ONLY the project URL and the PUBLISHABLE key (also called the "anon" key).
//
// NEVER put the secret key or the "service_role" key here. The site refuses to start if you do.
window.COOP_CONFIG = {
  SUPABASE_URL: 'https://okttuxgipxqioxfizhio.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_zfpuxKSrnghACY7ZYufUNQ_-qxlZ04B',
  TELEGRAM_BOT: 'Bentest_agentbot', // shown as the "Open in Telegram" link; leave '' to hide it
  CHAT_API: 'https://api.co-optech.com/web/chat', // where the dashboard's chat bar sends messages (an https address). Leave '' to switch website chat off.
};
