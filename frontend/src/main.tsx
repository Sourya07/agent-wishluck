import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import Layout from './components/Layout';
import { ToastProvider } from './components/ui';
import Inbox from './pages/Inbox';
import Orders from './pages/Orders';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import Store from './pages/Store';
import ChatPage from './pages/ChatPage';
import Track from './pages/Track';
import Pay from './pages/Pay';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/inbox" replace />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/inbox/:id" element={<Inbox />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:id" element={<Orders />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="/store" element={<Store />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/track/:awb" element={<Track />} />
          <Route path="/pay/:orderId" element={<Pay />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
