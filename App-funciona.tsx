import { useEffect, useRef, useState } from 'react';
import {
  defineComponents,
  DocumentReaderService,
  EventActions,
  InternalScenarios,
  type DocumentReaderWebComponent,
} from '@regulaforensics/vp-frontend-document-components';

function App() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<DocumentReaderWebComponent>(null);

  // ====== Buffers / estado ======
  const pagesBufferRef = useRef<string[]>([]);   // para plan B (frente → reverso)
  const awaitingBackRef = useRef<boolean>(false);
  const sessionImagesRef = useRef<string[]>([]); // imágenes capturadas por eventos

  // ====== abrir/cerrar escáner ======
  const openScanner = () => setOpen(true);
  const closeScanner = () => setOpen(false);

  // ====== utils base64 / bytes ======
  const bytesToBase64 = (bytes: ArrayBuffer | Uint8Array) => {
    const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    let bin = '';
    for (let i = 0; i < arr.byteLength; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  };
  const toDataUrl = (b64: string, mime?: string) => (mime ? `data:${mime};base64,${b64}` : b64);
  const looksLikeBase64 = (s: string) => /^[A-Za-z0-9+/=]+$/.test(s) && s.length > 5000;

  const maybePushBase64Image = (candidate: any, mimeHint?: string) => {
    if (typeof candidate !== 'string') return false;
    const isDataUrl = candidate.startsWith('data:image/');
    const isLikelyB64 = !isDataUrl && looksLikeBase64(candidate);
    if (isDataUrl || isLikelyB64) {
      sessionImagesRef.current.push(isDataUrl ? candidate : toDataUrl(candidate, mimeHint || 'image/jpeg'));
      return true;
    }
    return false;
  };

  const maybePushBytes = (candidate: any, mimeHint?: string) => {
    try {
      if (!candidate) return false;
      if (candidate instanceof ArrayBuffer || candidate instanceof Uint8Array) {
        const b64 = bytesToBase64(candidate);
        sessionImagesRef.current.push(toDataUrl(b64, mimeHint || 'image/jpeg'));
        return true;
      }
      if (candidate.data && (candidate.data instanceof ArrayBuffer || candidate.data instanceof Uint8Array)) {
        const b64 = bytesToBase64(candidate.data);
        sessionImagesRef.current.push(toDataUrl(b64, mimeHint || candidate.mime || 'image/jpeg'));
        return true;
      }
      if (candidate.bytes && (candidate.bytes instanceof ArrayBuffer || candidate.bytes instanceof Uint8Array)) {
        const b64 = bytesToBase64(candidate.bytes);
        sessionImagesRef.current.push(toDataUrl(b64, mimeHint || candidate.mime || 'image/jpeg'));
        return true;
      }
      if (candidate.buffer && (candidate.buffer instanceof ArrayBuffer || candidate.buffer instanceof Uint8Array)) {
        const b64 = bytesToBase64(candidate.buffer);
        sessionImagesRef.current.push(toDataUrl(b64, mimeHint || candidate.mime || 'image/jpeg'));
        return true;
      }
    } catch {}
    return false;
  };

  // ====== exploración profunda de ev.detail para encontrar imágenes ======
  const deepScanForImages = (obj: any): number => {
    let found = 0;
    const seen = new WeakSet<object>();
    const walk = (node: any) => {
      if (!node) return;
      const t = typeof node;

      if (t === 'string') {
        if (maybePushBase64Image(node)) found++;
        return;
      }
      if (node instanceof ArrayBuffer || node instanceof Uint8Array) {
        if (maybePushBytes(node)) found++;
        return;
      }
      if (Array.isArray(node)) {
        for (const it of node) walk(it);
        return;
      }
      if (t === 'object') {
        if (seen.has(node)) return;
        seen.add(node);

        if (node.image && maybePushBase64Image(node.image, node.mime || node.contentType)) found++;
        if (node.ImageData?.image && maybePushBase64Image(node.ImageData.image, node.ImageData?.mime || node.ImageData?.contentType)) found++;

        if (node.imageBytes && maybePushBytes(node.imageBytes, node.mime || node.contentType)) found++;
        if (node.bytes && maybePushBytes(node.bytes, node.mime || node.contentType)) found++;
        if (node.data && maybePushBytes(node.data, node.mime || node.contentType)) found++;
        if (node.buffer && maybePushBytes(node.buffer, node.mime || node.contentType)) found++;

        if (node.previewImage && maybePushBase64Image(node.previewImage)) found++;
        if (node.originalImage && maybePushBase64Image(node.originalImage)) found++;

        for (const v of Object.values(node)) walk(v);
      }
    };
    try { walk(obj); } catch {}
    return found;
  };

  // ====== códigos locales (solo para logs) ======
  const ResultType = { DOCUMENT_IMAGE: 5, IMAGES: 6 } as const;

  // ====== fallback de PROCESS_FINISHED por compatibilidad ======
  const collectDocPages = (response: any) => {
    const pagesByIdx = new Map<number, string>();
    const push = (b64: any, pageIdx: any) => {
      const data: string | null =
        (typeof b64 === 'string' ? b64 : (b64?.image ?? b64?.ImageData?.image ?? b64?.data ?? b64?.Value)) || null;
      if (!data) return;
      const idx =
        typeof pageIdx === 'number' ? pageIdx
        : typeof b64?.pageIdx === 'number' ? b64.pageIdx
        : typeof b64?.ImageData?.page_idx === 'number' ? b64.ImageData.page_idx
        : pagesByIdx.size;
      if (!pagesByIdx.has(idx)) pagesByIdx.set(idx, data);
    };

    const docImgRes =
      response?.results?.documentImage ||
      response?.results?.DOCUMENT_IMAGE ||
      response?.results?.[ResultType.DOCUMENT_IMAGE] ||
      response?.DocumentImage;

    const pushFromDocumentImage = (res: any) => {
      const list = res?.pageList ?? res?.List ?? res?.pages ?? res;
      if (Array.isArray(list)) {
        list.forEach((p: any, i: number) => {
          const b64 = p?.image ?? p?.ImageData?.image ?? p?.data ?? p;
          const pageIdx =
            typeof p?.pageIdx === 'number' ? p.pageIdx
            : typeof p?.ImageData?.page_idx === 'number' ? p.ImageData.page_idx
            : i;
          push(b64, pageIdx);
        });
      }
    };
    if (docImgRes) pushFromDocumentImage(docImgRes);

    const rawCandidates = [
      response?.rawImages,
      response?.lowLvlResponse?.RawImageContainerList?.Images,
      response?.rawResponse?.RawImageContainerList?.Images,
    ].filter(Boolean);

    rawCandidates.forEach((arr: any) => {
      if (Array.isArray(arr)) {
        arr.forEach((img: any, i: number) => {
          const b64 = img?.data ?? img?.image ?? img?.ImageData?.image ?? img?.Value;
          const pageIdx =
            typeof img?.pageIdx === 'number' ? img.pageIdx
            : typeof img?.ImageData?.page_idx === 'number' ? img.ImageData.page_idx
            : i;
          push(b64, pageIdx);
        });
      }
    });

    const containers =
      response?.lowLvlResponse?.ContainerList?.List ||
      response?.rawResponse?.ContainerList?.List;
    containers?.forEach((c: any) => {
      c?.Images?.List?.forEach((img: any, i: number) => {
        const b64 = img?.ImageData?.image ?? img?.image ?? img?.data;
        const pageIdx =
          typeof img?.ImageData?.page_idx === 'number' ? img.ImageData.page_idx
          : typeof img?.pageIdx === 'number' ? img.pageIdx
          : i;
        push(b64, pageIdx);
      });
    });

    return [pagesByIdx.get(0), pagesByIdx.get(1)].filter(Boolean) as string[];
  };

  // ====== Envío a tu API local (WebService) ======
  const sendToWebService = async (pagesBase64: string[]) => {
    const wsUrl = 'http://localhost:8080/api/process';

    const stripPrefix = (s: string) => s.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const images = pagesBase64.slice(0, 2).map((b64, idx) => {
      const clean = stripPrefix(b64);
      console.log(`➡️ IMG ${idx} size (chars):`, clean.length);
      return {
        ImageData: {
          image: clean,
          light: 6,
          page_idx: idx, // 0=frente, 1=rev
        },
      };
    });

    const payload = {
      processParam: {
        scenario: 'FullProcess',       // WebService sí usa FullProcess
        returnUncroppedImage: true,
        multipageProcessing: true,
      },
      List: images,
    };

    console.log('➡️ Payload listo. List count:', payload.List.length);
    console.log('➡️ POST a WS:', wsUrl);

    const response = await fetch(wsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    console.log('✅ Resultado del Web Service:', result);
    return result;
  };

  // ====== Listener de eventos ======
  useEffect(() => {
    const onEvent = async (ev: CustomEvent<any>) => {
      const { action, data } = ev.detail || {};
      console.log('🎯 EVENT:', action);

      // 1) En TODO evento intentamos raspar imágenes de ev.detail completo
      if (action !== EventActions.CLOSE) {
        const before = sessionImagesRef.current.length;
        const added = deepScanForImages(ev.detail);
        if (added > 0) {
          console.log(`🧲 ${action}: sumamos ${added} imagen(es) desde ev.detail. Total buffer: ${sessionImagesRef.current.length} (antes ${before})`);
        }
      }

      if (action === EventActions.NEW_PAGE_AVAILABLE) {
        console.log('🧪 NEW_PAGE_AVAILABLE keys detail:', Object.keys(ev.detail || {}));
        console.log('🧪 NEW_PAGE_AVAILABLE keys data:', Object.keys(data || {}));
      }

      if (action === EventActions.PROCESS_FINISHED) {
        console.log('✅ PROCESS_FINISHED');

        console.log('🔎 keys results:', Object.keys(data?.response?.results || {}));
        console.log(
          '🔎 has DOCUMENT_IMAGE:',
          !!(
            data?.response?.results?.documentImage ||
            data?.response?.results?.DOCUMENT_IMAGE ||
            data?.response?.results?.[ResultType.DOCUMENT_IMAGE] ||
            data?.response?.DocumentImage
          )
        );
        console.log(
          '🔎 has RawImageContainerList:',
          !!(
            data?.response?.lowLvlResponse?.RawImageContainerList?.Images ||
            data?.response?.rawResponse?.RawImageContainerList?.Images
          )
        );

        // A) intenta extraer desde response (compat)
        const response = data?.response;
        let pages = collectDocPages(response);

        // B) si no hay nada, usa el buffer de eventos
        if (!pages.length && sessionImagesRef.current.length) {
          const norm = sessionImagesRef.current.slice(0, 4); // por si vienen varias tomas
          pages = norm as string[];
          console.log(`🧾 Usando buffer de eventos: ${pages.length} img(s)`);
        }

        console.log(`📄 Páginas capturadas esta pasada: ${pages.length}`);

        if (pages.length === 0) {
          alert('No se pudieron extraer páginas del documento');
          return;
        }

        // ====== Atajo: si ya hay 2 o más en esta pasada, enviar ya mismo ======
        if (pages.length >= 2) {
          let front = pages[0];
          let back = pages[pages.length - 1];

          // si la última es muy similar a la primera, busca una distinta
          if (back === front || Math.abs((back?.length || 0) - (front?.length || 0)) < 50) {
            const candidate = pages.find((p) => p !== front);
            if (candidate) back = candidate;
          }
          if (!back) back = pages[1]; // aseguramos segunda

          try {
            const result = await sendToWebService([front, back]);
            console.log('🟢 WS OK (1 pasada):', result);
            alert('Documento procesado correctamente (2 páginas en una pasada)');
            // limpiar buffers + cerrar
            sessionImagesRef.current = [];
            pagesBufferRef.current = [];
            awaitingBackRef.current = false;
            closeScanner();
          } catch (e) {
            console.error('❌ Error WS (1 pasada):', e);
            alert('Error al procesar el documento en el Web Service');
          }
          return;
        }

        // ====== Plan B: solo 1 imagen → pedir reverso ======
        if (!awaitingBackRef.current) {
          const front = pages[0];
          if (!front) {
            alert('No se pudo obtener la cara frontal, intenta nuevamente');
            return;
          }
          pagesBufferRef.current = [front];
          awaitingBackRef.current = true;
          sessionImagesRef.current = []; // limpio para la 2ª pasada

          alert('Ahora da vuelta el documento y captura la PARTE TRASERA');
          closeScanner();
          setTimeout(() => openScanner(), 50);
          return;
        } else {
          // SEGUNDA pasada: esperamos reverso
          const front = pagesBufferRef.current[0];
          let back = pages[pages.length - 1];

          if (back === front || Math.abs((back?.length || 0) - (front?.length || 0)) < 50) {
            const candidate = pages.find((p) => p !== front);
            if (candidate) back = candidate;
          }
          if (!back) back = pages[0];

          if (!front || !back) {
            alert('No se pudo obtener la cara trasera, intenta nuevamente');
            return;
          }

          try {
            const result = await sendToWebService([front, back]);
            console.log('🟢 WS OK (2 pasadas):', result);
            alert('Documento procesado correctamente (2 páginas)');
            closeScanner();
          } catch (e) {
            console.error('❌ Error WS (2 pasadas):', e);
            alert('Error al procesar el documento en el Web Service');
          }

          // limpiar buffers
          sessionImagesRef.current = [];
          pagesBufferRef.current = [];
          awaitingBackRef.current = false;
        }
      }

      if (action === EventActions.CLOSE) {
        console.log('🚪 Componente cerrado');
        setOpen(false);
        // reset de buffers si se cierra manualmente
        sessionImagesRef.current = [];
        pagesBufferRef.current = [];
        awaitingBackRef.current = false;
      }
    };

    const container = containerRef.current;
    container?.addEventListener('document-reader', onEvent as any);
    return () => container?.removeEventListener('document-reader', onEvent as any);
  }, []);

  // ====== Inicialización del SDK (UI) ======
  useEffect(() => {
    (async () => {
      try {
        // @ts-ignore
        window.RegulaDocumentSDK = new DocumentReaderService();

        // En Web Components usa un escenario disponible (tu enum no trae FullProcess)
        // @ts-ignore
        window.RegulaDocumentSDK.recognizerProcessParam = {
          processParam: {
            scenario: InternalScenarios.MrzAndLocate,
            multipageProcessing: true,
            returnUncroppedImage: true,
            returnCroppedBarcode: true,
            // Si tu build no lo soporta, lo ignora:
            resultTypeOutput: [5, 6], // DOCUMENT_IMAGE, IMAGES
          },
        };

        // @ts-ignore
        window.RegulaDocumentSDK.imageProcessParam = {
          processParam: {
            scenario: InternalScenarios.MrzAndLocate,
            returnUncroppedImage: true,
          },
        };

        await defineComponents();

        // Licencia desde tu backend
        console.log('📥 Obteniendo licencia...');
        const res = await fetch('http://localhost:4000/api/regula/license');
        if (!res.ok) throw new Error('Error al obtener la licencia');

        const { licenseBase64 } = await res.json();
        console.log('📄 Licencia OK. Inicializando SDK...');
        // @ts-ignore
        await window.RegulaDocumentSDK.initialize({ license: licenseBase64 });
        console.log('✅ SDK inicializado');
      } catch (error) {
        console.error('❌ Error init SDK:', error);
        alert('Error al inicializar el lector de documentos');
      }
    })();

    return () => {
      // @ts-ignore
      window.RegulaDocumentSDK?.shutdown();
    };
  }, []);

  // ====== Ajustes visuales del componente ======
  useEffect(() => {
    if (elRef.current) {
      elRef.current.settings = {
        startScreen: true,
        changeCameraButton: true,
        internalScenario: InternalScenarios.MrzAndLocate,
        multipageProcessing: true,
      };
    }
  }, [open]);

  return (
    <div ref={containerRef} style={{ height: '100vh', width: '100%' }}>
      {open ? (
        <document-reader start-screen ref={elRef as any}></document-reader>
      ) : (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 12,
            height: '100%',
          }}
        >
          <button
            onClick={openScanner}
            style={{
              padding: '15px 30px',
              fontSize: '18px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer',
            }}
          >
            Escanear Documento (MrzAndLocate → FullProcess WS)
          </button>
          {awaitingBackRef.current && (
            <span style={{ fontSize: 14 }}>
              Capturaste frente. Ahora captura <b>REVERSO</b>.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
