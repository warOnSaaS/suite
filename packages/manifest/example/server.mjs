// The smallest server part: one handler per tool in tools.json. The suite calls register(ctx) once,
// only when at least one team has the app on.
const now = () => new Date().toISOString();
const id = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

export default function register(ctx) {
  return {
    handlers: {
      async 'chat.post_message'({ channel_id, text, thread_id }, call) {
        const msg = { id: id('msg'), created_at: now() };
        await ctx.db.run('INSERT INTO chat_messages (id, team_id, channel_id, thread_id, author_kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [msg.id, call.team.id, channel_id, thread_id ?? null, call.actor.kind, call.actor.id, text, msg.created_at]);
        call.emit('chat.message.posted', { id: msg.id, channel_id });
        return msg;
      },
      async 'chat.delete_channel'({ channel_id }, call) {
        const r = await ctx.db.run('DELETE FROM chat_channels WHERE team_id = ? AND id = ?', [call.team.id, channel_id]);
        await ctx.db.run('DELETE FROM chat_messages WHERE team_id = ? AND channel_id = ?', [call.team.id, channel_id]);
        call.emit('chat.channel.deleted', { id: channel_id });
        return { deleted: r.changes > 0 };
      },
    },
  };
}
