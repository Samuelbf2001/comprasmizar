import { redirect } from 'next/navigation';
import MizarApp from '../../components/mizar-app';
import { getAuthSnapshot, isDemoMode, loginErrorParam } from '../auth-guard';
import { isPublicConfigured } from '../../lib/security/env';

export default async function CatchAllPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const requestedPath = `/${slug.join('/')}`;
  if (requestedPath === '/requisiciones/publica' || requestedPath === '/requisiciones/publica-movil') {
    const demoMode = isDemoMode();
    return <MizarApp initialRole="Solicitante" demoMode={demoMode} actorName="Portal público" publicConfigured={!demoMode && isPublicConfigured()} />;
  }
  const auth = await getAuthSnapshot();
  if (!auth.authenticated && !auth.demoMode) redirect(`/login?next=${encodeURIComponent(requestedPath)}${loginErrorParam(auth.reason)}`);
  return <MizarApp initialRole={auth.role} demoMode={auth.demoMode} actorName={auth.displayName} />;
}
