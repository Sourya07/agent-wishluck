import type React from 'react';
import { useEffect, useState } from 'react';
import ChatWidget from '../components/ChatWidget';
import { IChat, IX } from '../components/icons';

const PRODUCTS = [
  { name: 'Cotton printed kurta', price: 1299, tag: 'Bestseller', shape: 'kurta' },
  { name: 'Oversized graphic tee', price: 699, tag: 'New', shape: 'tee' },
  { name: 'Relaxed fit jeans', price: 1799, shape: 'jeans' },
  { name: 'Cotton briefs, pack of 3', price: 499, tag: 'Innerwear · no returns', shape: 'briefs' },
  { name: 'Canvas tote bag', price: 899, shape: 'bag' },
  { name: 'Sale tee', price: 399, tag: 'Sale · exchange only', shape: 'tee' },
];

const SHAPES: Record<string, React.ReactElement> = {
  kurta: <path d="M35 10h30l12 10-8 12-6-4v62H37V28l-6 4-8-12z M45 10c0 6 10 6 10 0" />,
  tee: <path d="M30 14l12-4c2 6 14 6 16 0l12 4 14 14-10 10-6-5v51H32V33l-6 5-10-10z" />,
  jeans: <path d="M32 8h36l6 84H56L50 40l-6 52H26z M32 18h36" />,
  briefs: <path d="M18 30h64v10c-10 4-18 16-20 30H38c-2-14-10-26-20-30z" />,
  bag: <path d="M24 34h52l-4 56H28z M38 34c0-22 24-22 24 0" />,
};

export default function Store() {
  const [open, setOpen] = useState(true);
  useEffect(() => { document.title = 'Wishluck — Everyday cotton'; }, []);
  return (
    <div className="store">
      <nav className="store-nav">
        <span className="store-logo">WISHLUCK</span>
        <a href="#">New in</a><a href="#">Kurtas</a><a href="#">Tees</a><a href="#">Denim</a><a href="#">Sale</a>
        <span style={{ marginLeft: 'auto' }} className="small muted">Free shipping above ₹999 · COD available</span>
      </nav>
      <section className="hero">
        <div>
          <span className="badge">Demo storefront</span>
          <h2>Everyday cotton,<br />made in India.</h2>
          <p>This is a mock store to try the support assistant as a customer. Open the chat and ask about an order — try <b>WL10234</b> with phone <b>9876543210</b>, or write in Hinglish.</p>
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => setOpen(true)}><IChat /> Chat with support</button>
        </div>
        <div className="hero-art">WISHLUCK</div>
      </section>
      <section className="products">
        {PRODUCTS.map((p) => (
          <div key={p.name} className="product">
            <div className="img">{p.tag && <span className="badge tag">{p.tag}</span>}<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round">{SHAPES[p.shape]}</svg></div>
            <h4>{p.name}</h4>
            <div className="price">₹{p.price.toLocaleString('en-IN')}</div>
          </div>
        ))}
      </section>
      {open && <ChatWidget onClose={() => setOpen(false)} />}
      <button className="widget-fab" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close chat' : 'Open chat'}>{open ? <IX /> : <IChat />}</button>
    </div>
  );
}
