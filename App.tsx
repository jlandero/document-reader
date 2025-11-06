import { CSSProperties, useEffect, useRef, useState } from 'react';
import {
  defineComponents,
  DocumentReaderService,
  EventActions,
  InternalScenarios,
  type DocumentReaderDetailType,
  type DocumentReaderWebComponent,
} from '@regulaforensics/vp-frontend-document-components';

/** -----------------------------------------------
 *  CONFIG
 *  ----------------------------------------------- */
const BASE_URL = (import.meta as any).env?.VITE_BACKEND_BASE_URL || 'http://localhost:8080';

/** -----------------------------------------------
 *  UI
 *  ----------------------------------------------- */
const containerStyle: CSSProperties = {
  display: 'flex',
  position: 'absolute',
  height: '100%',
  width: '100%',
  top: 0,
  left: 0,
  justifyContent: 'center',
  alignItems: 'center',
};
const buttonStyle: CSSProperties = {
  padding: '10px 30px',
  color: 'white',
  fontSize: '16px',
  borderRadius: '2px',
  backgroundColor: '#bd7dff',
  border: '1px solid #bd7dff',
  cursor: 'pointer',
};

/** -----------------------------------------------
 *  HELPERS
 *  ----------------------------------------------- */
function stripDataUrlPrefix(s: string) { return s.replace(/^data:image\/[a-z+]+;base64,/, ''); }
function isB64(s: any): s is string { return typeof s === 'string' && s.length > 80 && /^(?:data:image\/[a-z+]+;base64,|\/9j\/|iVBOR|R0lGOD|JVBER)/.test(s); }
function safeNormalize<T = any>(v: any): T { try { return JSON.parse(JSON.stringify(v)); } catch { return (v ?? {}) as T; } }

/** Busca TODAS las cadenas base64 dentro de un objeto (profundo) */
function deepFindAllBase64(obj: any, limit = 4000): string[] {
  const out: string[] = [];
  const stack: any[] = [obj];
  const seen = new WeakSet();
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue; seen.add(cur);
    for (const k of Object.keys(cur)) {
      const v = (cur as any)[k];
      if (isB64(v)) out.push(v);
      if (v && typeof v === 'object') stack.push(v);
      if (Array.isArray(v)) for (const it of v) stack.push(it);
    }
  }
  return out;
}

function collectFromPage(page: any): string[] {
  const out = new Set<string>();
  if (!page || typeof page !== 'object') return [];
  const cands = [
    page.image, page.Image,
    page.originalImage, page.OriginalImage,
    page.uncropped, page.full, page.cropped, page.front, page.back,
  ];
  for (const v of cands) if (isB64(v)) out.add(v);
  for (const k of Object.keys(page)) {
    const v = (page as any)[k];
    if (v && typeof v === 'object') {
      for (const kk of ['image','Image','originalImage','OriginalImage','uncropped','full','cropped']) {
        const vv = (v as any)[kk];
        if (isB64(vv)) out.add(vv);
      }
    }
  }
  return Array.from(out);
}

/** Convierte cualquier variante de containerList → List[].ImageData eligiendo el b64 más largo por item */
function containerListToListImageData(containerList: any) {
  const rootList = Array.isArray(containerList)
    ? containerList
    : (Array.isArray(containerList?.List) ? containerList.List
      : (Array.isArray(containerList?.list) ? containerList.list : []));

  const out: Array<{ ImageData: { image: string; light: number; page_idx: number } }> = [];
  let idx = 0;
  for (let i = 0; i < rootList.length; i++) {
    const item = rootList[i];
    if (!item || typeof item !== 'object') continue;

    // directo: ImageData.image / Bytes / Base64
    const id = (item as any).ImageData;
    if (id && (isB64(id.image) || isB64(id?.Bytes) || isB64(id?.Base64))) {
      const best = id.image || id.Bytes || id.Base64;
      out.push({ ImageData: { image: stripDataUrlPrefix(best), light: 6, page_idx: idx++ } });
      continue;
    }

    // candidatos directos
    const direct = [
      (item as any).image, (item as any).Image,
      (item as any).Bytes, (item as any).Base64,
      (item as any).data, (item as any).Data,
      (item as any).value, (item as any).Value,
    ].filter(isB64);

    if (direct.length) {
      const best = direct.reduce((a, b) => (a.length >= b.length ? a : b));
      out.push({ ImageData: { image: stripDataUrlPrefix(best), light: 6, page_idx: idx++ } });
      continue;
    }

    // deep: elige el base64 más largo
    const all = deepFindAllBase64(item);
    if (all.length) {
      const best = all.reduce((a, b) => (a.length >= b.length ? a : b));
      out.push({ ImageData: { image: stripDataUrlPrefix(best), light: 6, page_idx: idx++ } });
      continue;
    }
  }
  return out;
}

async function postJSON(url: string, body: any) {
  console.log('%c[HTTP] → POST ' + url, 'color:#0bf', body);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  console.log('%c[HTTP] ← ' + res.status + ' ' + url, 'color:#0bf', json ?? text);
  if (!res.ok) { const err: any = new Error(`${url} ${res.status}: ${text}`); err.status = res.status; throw err; }
  return json ?? text;
}

function makeListFromImages(imagesB64: string[]) {
  return imagesB64.map((raw, idx) => ({ ImageData: { image: stripDataUrlPrefix(raw), light: 6, page_idx: idx } }));
}

/** Firma simple para evitar doble POST con mismo body */
function bodySig(List: Array<{ ImageData: { image: string } }>) {
  return `${List.length}|` + List.map(x => x.ImageData.image.length).join(',');
}

/** -----------------------------------------------
 *  APP
 *  ----------------------------------------------- */
export default function App() {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const elRef = useRef<DocumentReaderWebComponent>(null);
  const imagesRef = useRef<string[]>([]);
  const lastContainerListRef = useRef<any | null>(null);
  const postGateRef = useRef<{sent: boolean, sig: string}>({ sent: false, sig: '' });

  const sendProcessList = async (List: Array<{ ImageData: { image: string; light: number; page_idx: number } }>) => {
    const url = `${String(BASE_URL).replace(/\/+$/, '')}/api/process`;
    const sig = bodySig(List);
    if (postGateRef.current.sent && postGateRef.current.sig === sig) {
      console.warn('Skip: mismo payload ya enviado.');
      return;
    }
    postGateRef.current = { sent: true, sig };

    const body = {
      processParam: { scenario: 'FullProcess', returnUncroppedImage: true, multipageProcessing: true },
      List,
    };
    await postJSON(url, body);
  };

  const onEvt = async (e: CustomEvent<DocumentReaderDetailType>) => {
    const action = e.detail?.action;
    const data = (e.detail as any)?.data ?? {};

    // Detecta containerList profundo (una sola vez)
    if (!lastContainerListRef.current) {
      const normalized = safeNormalize(e.detail);
      const stack: any[] = [normalized]; const seen = new WeakSet();
      while (stack.length && !lastContainerListRef.current) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (seen.has(cur)) continue; seen.add(cur);
        for (const k of Object.keys(cur)) {
          const v = (cur as any)[k];
          if (/containerlist/i.test(k)) { lastContainerListRef.current = v; console.log('[collector/containerList] detectado (profundo).'); break; }
          if (v && typeof v === 'object') stack.push(v);
          if (Array.isArray(v)) for (const it of v) stack.push(it);
        }
      }
    }

    // Colecta por página (si tu build lo expone)
    if (action === EventActions.NEW_PAGE_AVAILABLE || action === EventActions.NEW_PAGE_STARTED || action === 'NEW_PAGE_COMPLETED') {
      const pics = collectFromPage((data as any)?.page);
      if (pics.length) {
        const before = imagesRef.current.length;
        imagesRef.current = Array.from(new Set([...imagesRef.current, ...pics]));
        const added = imagesRef.current.length - before;
        if (added > 0) console.log(`[collector/page] +${added} img(s) (total=${imagesRef.current.length})`);
      } else {
        console.log('[collector/page] no hay imágenes en data.page');
      }
    }

    if (action === EventActions.PROCESS_FINISHED) {
      const status = (data as any)?.status ?? 0;
      console.log('[PROCESS_FINISHED] status=', status, 'imgs buffer=', imagesRef.current.length, 'hasContainerList=', !!lastContainerListRef.current);
      if (status !== 1 && status !== 2) {
        const reason = (data as any)?.reason || (data as any)?.message || 'Proceso no exitoso';
        alert(`Captura no exitosa: ${reason}`);
        return;
      }

      try {
        // 1) Preferir imágenes de páginas
        if (imagesRef.current.length) {
          const List = makeListFromImages(imagesRef.current);
          console.log('[BACK] usando imágenes de página → /api/process con', List.length, 'página(s)');
          await sendProcessList(List);
          return;
        }
        // 2) Fallback: containerList
        if (lastContainerListRef.current) {
          const List = containerListToListImageData(lastContainerListRef.current);
          console.log('[containerList] convertidas', List.length, 'páginas desde containerList');
          if (List.length) {
            console.log('[BACK] usando containerList convertido → /api/process con', List.length, 'página(s)');
            await sendProcessList(List);
            alert(`OK: enviadas ${List.length} imagen(es) (from containerList)`);
            return;
          }
          console.warn('[containerList] sin base64 aprovechable');
        }
        alert('No hay imágenes en buffer ni containerList utilizable. Repite la captura.');
      } catch (ex: any) {
        console.error('Fallo /api/process:', ex);
        alert('Fallo /api/process: ' + (ex?.message || String(ex)));
      }
    }

    if (action === EventActions.CLOSE) {
      postGateRef.current = { sent: false, sig: '' };
      setOpen(false);
    }
  };

  /** ---------- Setup SDK y suscripción ÚNICA (window) ---------- */
  useEffect(() => {
    (async () => {
      try {
        await defineComponents();
        const license = (import.meta as any).env?.VITE_REGULA_LICENSE;
        if (!license) throw new Error('Falta VITE_REGULA_LICENSE en .env (licencia base64)');

        (window as any).RegulaDocumentSDK = new DocumentReaderService();

        (window as any).RegulaDocumentSDK.videoProcessParam = {
          processParam: {
            scenario: InternalScenarios.MrzAndLocate,
            multipageProcessing: true,
            // @ts-ignore
            returnPackageForReprocess: true,
            // @ts-ignore
            returnUncroppedImage: true,
          },
          resultTypeOutput: ['DocumentImage'],
        };
        (window as any).RegulaDocumentSDK.imageProcessParam = {
          processParam: { scenario: InternalScenarios.MrzAndLocate, /* @ts-ignore */ returnUncroppedImage: true },
          resultTypeOutput: ['DocumentImage'],
        };
        (window as any).RegulaDocumentSDK.recognizerProcessParam = {
          processParam: {
            scenario: InternalScenarios.MrzAndLocate,
            multipageProcessing: true,
            // @ts-ignore
            returnPackageForReprocess: true,
            // @ts-ignore
            returnUncroppedImage: true,
          },
          resultTypeOutput: ['DocumentImage'],
        };
        (window as any).RegulaDocumentSDK.resultTypeOutput = ['DocumentImage'];

        await (window as any).RegulaDocumentSDK.initialize({ license });
        console.log('Regula SDK inicializado OK.');

        // 🔴 Suscripción ÚNICA → window
        window.addEventListener('document-reader', onEvt as any);

        setReady(true);
      } catch (e: any) {
        console.error('Fallo initialize:', e);
        setErr(e?.message || String(e));
      }
      return () => {
        try { (window as any).RegulaDocumentSDK?.shutdown?.(); } catch {}
        window.removeEventListener('document-reader', onEvt as any);
      };
    })();
  }, []);

  useEffect(() => {
    if (!elRef.current) return;
    elRef.current.settings = { changeCameraButton: true };
  }, [open]);

  return (
    <div style={containerStyle}>
      {open ? (
        <document-reader start-screen ref={elRef}></document-reader>
      ) : (
        <div style={{ display: 'grid', gap: 12, minWidth: 380 }}>
          <button
            style={{ ...buttonStyle, opacity: ready ? 1 : 0.6 }}
            disabled={!ready}
            onClick={() => {
              postGateRef.current = { sent: false, sig: '' };
              imagesRef.current = [];
              lastContainerListRef.current = null;
              setOpen(true);
            }}
          >
            {ready ? 'Open component' : 'Cargando SDK…'}
          </button>
          {err && <div style={{ color: 'tomato', maxWidth: 560, fontFamily: 'monospace' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
