/**
 * IndexedDB storage for HTML5 FileSystemDirectoryHandle objects.
 * Enables persistent folder access permissions across app restarts and Graph Pair switches.
 */

const DB_NAME = 'logseq_translator_handles_db';
const STORE_NAME = 'dir_handles';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Persists a FileSystemDirectoryHandle into IndexedDB.
 */
export async function saveDirectoryHandle(key: string, handle: any): Promise<void> {
  if (!handle || typeof handle !== 'object' || !('getDirectoryHandle' in handle)) {
    return;
  }
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[HandleStore] Failed to save DirectoryHandle to IndexedDB:', err);
  }
}

/**
 * Retrieves a FileSystemDirectoryHandle from IndexedDB.
 */
export async function getDirectoryHandle(key: string): Promise<any | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const result = req.result;
        if (result && typeof result === 'object' && 'getDirectoryHandle' in result) {
          resolve(result);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('[HandleStore] Failed to retrieve DirectoryHandle from IndexedDB:', err);
    return null;
  }
}

/**
 * Removes a stored FileSystemDirectoryHandle from IndexedDB.
 */
export async function removeDirectoryHandle(key: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[HandleStore] Failed to delete DirectoryHandle from IndexedDB:', err);
  }
}

/**
 * Verifies or requests write permissions for a FileSystemDirectoryHandle.
 * IMPORTANT: MUST be called during a User Gesture (e.g. click event) if requestPermission is needed.
 */
export async function verifyHandlePermission(handle: any, readWrite = true): Promise<boolean> {
  if (!handle || typeof handle !== 'object') return false;

  const mode = readWrite ? 'readwrite' : 'read';
  const options = { mode };

  try {
    if (typeof handle.queryPermission === 'function') {
      const currentStatus = await handle.queryPermission(options);
      if (currentStatus === 'granted') {
        return true;
      }
    }

    if (typeof handle.requestPermission === 'function') {
      const requestedStatus = await handle.requestPermission(options);
      return requestedStatus === 'granted';
    }

    return true;
  } catch (err) {
    console.warn('[HandleStore] Permission check failed:', err);
    return false;
  }
}
