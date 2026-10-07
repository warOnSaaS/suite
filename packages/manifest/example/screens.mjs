// The smallest screen part. Plain DOM here; React or anything else works the same way.
// Every button names its tool in data-tool, and calls it through ctx.callTool.
export default {
  title: 'Chat',
  mount(el, ctx) {
    el.innerHTML = `<div class="ui-page"><div class="ui-ph"><h1>Chat</h1></div>
      <form class="ui-composer"><input name="text" placeholder="Message #general" aria-label="Message"><button class="ui-send" data-tool="chat.post_message" aria-label="Send">&uarr;</button></form></div>`;
    const form = el.querySelector('form');
    const onSubmit = async (e) => {
      e.preventDefault();
      await ctx.callTool('chat.post_message', { channel_id: 'ch_general', text: form.text.value });
      form.reset();
      ctx.toast('Sent');
    };
    form.addEventListener('submit', onSubmit);
    const off = ctx.on('chat.message.posted', () => {});
    return () => { form.removeEventListener('submit', onSubmit); off(); };
  },
};
