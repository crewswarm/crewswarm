import { SessionManager } from './src/session/manager.ts';

const sm = new SessionManager('/Users/jeffhobbs/CrewSwarm/crew-cli/testproject');
await sm.ensureInitialized();

console.log('📝 Appending test entry...');
await sm.appendHistory({
  type: 'repl_chat',
  input: 'test direct call',
  response: 'test response from direct call'
});

console.log('✅ Done - check file');
