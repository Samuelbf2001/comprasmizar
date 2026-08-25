import { ResetForm } from '../../components/auth/auth-form';
import { AuthFrame } from '../../components/auth/auth-form';

export default function ResetPage() { return <AuthFrame title="Recupera tu acceso" description="Te enviaremos instrucciones únicamente si el servicio de autenticación está configurado."><ResetForm /></AuthFrame>; }
