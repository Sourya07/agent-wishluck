import { useParams } from 'react-router-dom';
import ChatWidget from '../components/ChatWidget';

/** Full-page customer chat for a specific conversation (e.g. the COD / NDR message we sent proactively). */
export default function ChatPage() {
  const { id } = useParams();
  return <div style={{ height: '100%', background: 'var(--bg)' }}><ChatWidget conversationId={id} full /></div>;
}
