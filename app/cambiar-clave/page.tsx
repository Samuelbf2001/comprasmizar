import { redirect } from 'next/navigation';
import { AuthFrame, PasswordForm } from '../../components/auth/auth-form';
import { getAuthSnapshot } from '../auth-guard';

export default async function ChangePasswordPage() { const auth = await getAuthSnapshot(); if (!auth.authenticated) redirect('/login?next=/cambiar-clave'); return <AuthFrame title="Crea una contraseña nueva" description="Elige una contraseña de al menos 8 caracteres para continuar."><PasswordForm /></AuthFrame>; }
