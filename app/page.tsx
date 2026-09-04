import { redirect } from 'next/navigation';
import MizarApp from '../components/mizar-app';
import { getAuthSnapshot, loginErrorParam } from './auth-guard';

export default async function Page() {
  const auth = await getAuthSnapshot();
  if (!auth.authenticated && !auth.demoMode) {
    redirect(`/login?next=${encodeURIComponent('/')}${loginErrorParam(auth.reason)}`);
  }
  return <MizarApp initialRole={auth.role} demoMode={auth.demoMode} actorName={auth.displayName} />;
}
