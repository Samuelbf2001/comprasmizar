import { redirect } from 'next/navigation';
import MizarApp from '../components/mizar-app';
import { getAuthSnapshot } from './auth-guard';

export default async function Page() {
  const auth = await getAuthSnapshot();
  if (!auth.authenticated && !auth.demoMode) {
    const accessError = auth.reason === 'role' || auth.reason === 'inactive' ? '&error=access_denied' : '';
    redirect(`/login?next=${encodeURIComponent('/')}${accessError}`);
  }
  return <MizarApp initialRole={auth.role} demoMode={auth.demoMode} actorName={auth.displayName} />;
}
