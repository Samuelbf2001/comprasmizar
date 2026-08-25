import { redirect } from 'next/navigation';
import MizarApp from '../../components/mizar-app';
import { getAuthSnapshot, isDemoMode } from '../auth-guard';
import { isPublicConfigured } from '../../lib/security/env';

export default async function CatchAllPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const requestedPath = `/${slug.join('/')}`;
  if (requestedPath === '/requisiciones/publica') {
    const demoMode = isDemoMode();
    return <MizarApp initialRole="Solicitante" demoMode={demoMode} actorName="Portal público" publicConfigured={!demoMode && isPublicConfigured()} />;
  }
  const auth = await getAuthSnapshot();
  if (!auth.authenticated && !auth.demoMode) redirect(`/login?next=${encodeURIComponent(requestedPath)}${auth.reason === 'role' || auth.reason === 'inactive' ? '&error=access_denied' : ''}`);
  return <MizarApp initialRole={auth.role} demoMode={auth.demoMode} actorName={auth.displayName} />;
}
