import { AuthFrame, LoginForm } from '../../components/auth/auth-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : '/';
  return <AuthFrame title="Inicia sesión" description="Accede con el usuario autorizado por Mizar."><LoginForm next={next} updated={params.updated === '1'} callbackError={params.error === 'auth_callback'} accessDenied={params.error === 'access_denied'} configError={params.error === 'config'} /></AuthFrame>;
}
