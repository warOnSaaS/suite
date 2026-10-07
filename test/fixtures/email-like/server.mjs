// Stand-in Email app: routes a command email to another app's tool as the sender, and sends alert emails.
export const sent = [];
export default function register(ctx) {
  return {
    handlers: {
      async 'email.run_command'({ from, tool, input }, call) {
        const person = await ctx.people.byEmail(call.team.id, from);
        if (!person) throw new Error(`${from} is not on this team`);
        return { out: await ctx.callAs({ teamId: call.team.id, personId: person.id, via: 'email' }, tool, input ?? {}) };
      },
    },
    alertTransport: { async send(a) { sent.push(a); } },
    answerFromReply: (alertId, personId, text) => ctx.alerts.answer(alertId, personId, text, 'email'),
  };
}
