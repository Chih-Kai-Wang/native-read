(() => {
  if (globalThis.KCTCacheDB) return;

  const DB_NAME = 'kct_cache_db_v2';
  const DB_VERSION = 1;
  const STORE_NAME = 'entries';
  const MAX_ENTRIES = 20000;
  const LEGACY_CACHE_KEY = 'kct_translation_cache_v1';
  const TOUCH_THRESHOLD_MS = 60 * 1000;
  const TOUCH_DEBOUNCE_MS = 250;
  const TOUCH_MAX_BATCH = 200;
  const OPEN_TIMEOUT_MS = 3000;
  const STATS_BATCH_SIZE = 500;
  const STATS_TIMEOUT_MS = 5000;

  let dbPromise = null;
  let migrationPromise = null;
  const pendingTouches = new Map();
  let touchTimer = null;
  let activeFlushPromise = null;
  let activeStatsPromise = null;
  let dbEpoch = 0;

  function resetDbHandleIfCurrent(openedPromise) {
    if (!openedPromise || dbPromise === openedPromise) {
      dbPromise = null;
    }
  }

  function openDB() {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB unavailable'));
    }
    if (dbPromise) return dbPromise;

    const holder = { promise: null };
    const createdPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (dbPromise === holder.promise) {
          dbPromise = null;
        }
        reject(new Error('IndexedDB open timeout'));
      }, OPEN_TIMEOUT_MS);

      const finishResolve = (db) => {
        clearTimeout(timer);
        settled = true;
        resolve(db);
      };

      const finishReject = (err) => {
        clearTimeout(timer);
        if (dbPromise === holder.promise) {
          dbPromise = null;
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          let store;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          } else {
            store = req.transaction.objectStore(STORE_NAME);
          }
          if (!store.indexNames.contains('ts')) {
            store.createIndex('ts', 'ts', { unique: false });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          if (settled) {
            try {
              db.close();
            } catch (_) {}
            return;
          }
          db.onversionchange = () => {
            try {
              db.close();
            } catch (_) {}
            if (dbPromise === holder.promise) {
              dbPromise = null;
            }
          };
          db.onclose = () => {
            if (dbPromise === holder.promise) {
              dbPromise = null;
            }
          };
          finishResolve(db);
        };
        req.onerror = () => {
          finishReject(req.error || new Error('Failed to open IndexedDB'));
        };
        req.onblocked = () => {
          finishReject(new Error('IndexedDB open blocked'));
        };
      } catch (err) {
        finishReject(err);
      }
    });

    holder.promise = createdPromise;
    dbPromise = createdPromise;
    return createdPromise;
  }

  function queueTouch(keys, ts) {
    if (!Array.isArray(keys) || keys.length === 0) return;
    for (const key of keys) {
      if (typeof key !== 'string' || !key) continue;
      pendingTouches.set(key, Math.max(pendingTouches.get(key) || 0, ts));
    }
    if (pendingTouches.size === 0) return;
    if (pendingTouches.size >= TOUCH_MAX_BATCH) {
      if (touchTimer) {
        clearTimeout(touchTimer);
        touchTimer = null;
      }
      void flushTouches();
      return;
    }
    if (touchTimer) {
      clearTimeout(touchTimer);
    }
    touchTimer = setTimeout(() => {
      touchTimer = null;
      void flushTouches();
    }, TOUCH_DEBOUNCE_MS);
  }

  async function flushTouches() {
    while (pendingTouches.size > 0 || activeFlushPromise) {
      if (activeFlushPromise) {
        await activeFlushPromise.catch(() => {});
        continue;
      }
      const flushEpoch = dbEpoch;
      const batch = [];
      for (const [key, touchTs] of pendingTouches) {
        batch.push([key, touchTs]);
        pendingTouches.delete(key);
        if (batch.length >= TOUCH_MAX_BATCH) break;
      }
      if (batch.length === 0) break;

      activeFlushPromise = (async () => {
        let openPromise = null;
        try {
          openPromise = openDB();
          const db = await openPromise;
          if (flushEpoch !== dbEpoch) return;
          await new Promise((resolve) => {
            try {
              const tx = db.transaction(STORE_NAME, 'readwrite');
              const store = tx.objectStore(STORE_NAME);
              for (const [key, touchTs] of batch) {
                const req = store.get(key);
                req.onsuccess = () => {
                  try {
                    if (flushEpoch !== dbEpoch) return;
                    const rec = req.result;
                    if (
                      rec &&
                      typeof rec.zh === 'string' &&
                      rec.zh.trim() &&
                      (!Number.isFinite(rec.ts) || rec.ts < touchTs)
                    ) {
                      const putReq = store.put({ key: rec.key, zh: rec.zh, ts: touchTs });
                      putReq.onerror = (e) => {
                        try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
                      };
                    }
                  } catch (_) {}
                };
                req.onerror = (e) => {
                  try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
                };
              }
              tx.oncomplete = () => resolve();
              tx.onerror = (e) => {
                try { e?.stopPropagation?.(); } catch (_) {}
                resolve();
              };
              tx.onabort = () => resolve();
            } catch (txErr) {
              if (txErr?.name === 'InvalidStateError') {
                resetDbHandleIfCurrent(openPromise);
              }
              resolve();
            }
          });
        } catch (_) {
          // Swallow background touch failures
        } finally {
          activeFlushPromise = null;
        }
      })();
      await activeFlushPromise;
    }
  }

  async function getMany(keys) {
    const result = new Map();
    if (!Array.isArray(keys) || keys.length === 0) return result;
    const uniqueKeys = Array.from(new Set(keys.filter((k) => typeof k === 'string' && k.length > 0)));
    if (uniqueKeys.length === 0) return result;

    const readEpoch = dbEpoch;
    const now = Date.now();
    const staleHitKeys = [];

    let openPromise = null;
    try {
      openPromise = openDB();
      const db = await openPromise;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);

          for (const key of uniqueKeys) {
            const req = store.get(key);
            req.onsuccess = () => {
              try {
                const rec = req.result;
                if (rec && typeof rec.zh === 'string' && rec.zh.trim()) {
                  result.set(key, rec.zh);
                  if (!Number.isFinite(rec.ts) || (now - rec.ts) >= TOUCH_THRESHOLD_MS) {
                    staleHitKeys.push(key);
                  }
                }
              } catch (_) {}
            };
          }

          tx.oncomplete = () => {
            if (staleHitKeys.length > 0 && readEpoch === dbEpoch) {
              queueTouch(staleHitKeys, now);
            }
            resolve(result);
          };
          tx.onerror = () => resolve(result);
          tx.onabort = () => resolve(result);
        } catch (txErr) {
          if (txErr?.name === 'InvalidStateError') {
            resetDbHandleIfCurrent(openPromise);
          }
          resolve(result);
        }
      });
    } catch (_) {
      return result;
    }
  }

  function deleteOldestFromSource(store, source, count) {
    if (!store || !source || !Number.isFinite(count) || count <= 0) return;
    if (typeof source.getAllKeys === 'function') {
      const keysReq = source.getAllKeys(null, count);
      keysReq.onsuccess = () => {
        try {
          const keys = Array.isArray(keysReq.result) ? keysReq.result : [];
          for (const pk of keys) {
            const delReq = store.delete(pk);
            if (delReq && typeof delReq === 'object') {
              delReq.onerror = (e) => {
                try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
              };
            }
          }
        } catch (_) {}
      };
      keysReq.onerror = (e) => {
        try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
      };
      return;
    }

    let remaining = count;
    const cursorReq = source.openCursor(null, 'next');
    cursorReq.onsuccess = () => {
      try {
        const cursor = cursorReq.result;
        if (cursor && remaining > 0) {
          const delReq = cursor.delete();
          if (delReq && typeof delReq === 'object') {
            delReq.onerror = (e) => {
              try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
            };
          }
          remaining -= 1;
          if (remaining > 0) {
            cursor.continue();
          }
        }
      } catch (_) {}
    };
    cursorReq.onerror = (e) => {
      try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
    };
  }

  function evictOldestFraction(db, openPromise, fraction = 0.2) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const countReq = store.count();
        countReq.onsuccess = () => {
          try {
            const total = countReq.result || 0;
            const toDelete = Math.max(10, Math.ceil(total * fraction));
            if (total === 0) return;
            deleteOldestFromSource(store, store.index('ts'), toDelete);
          } catch (_) {}
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (txErr) {
        if (txErr?.name === 'InvalidStateError') {
          resetDbHandleIfCurrent(openPromise);
        }
        resolve(false);
      }
    });
  }

  function writeEntriesWithCap(db, openPromise, valid, writeEpoch) {
    return new Promise((resolve) => {
      if (writeEpoch !== dbEpoch) {
        resolve({ ok: false, quotaExceeded: false });
        return;
      }
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let sawQuota = false;

        for (const rec of valid) {
          const putReq = store.put(rec);
          putReq.onerror = () => {
            if (putReq.error?.name === 'QuotaExceededError') {
              sawQuota = true;
            }
          };
        }

        const countReq = store.count();
        countReq.onsuccess = () => {
          try {
            const overflow = (countReq.result || 0) - MAX_ENTRIES;
            if (overflow > 0) {
              deleteOldestFromSource(store, store.index('ts'), overflow);
            }
          } catch (_) {}
        };
        countReq.onerror = (e) => {
          try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
        };

        tx.oncomplete = () => resolve({ ok: true, quotaExceeded: false });
        tx.onerror = () => {
          const isQuota = sawQuota || tx.error?.name === 'QuotaExceededError';
          resolve({ ok: false, quotaExceeded: isQuota });
        };
        tx.onabort = () => {
          const isQuota = sawQuota || tx.error?.name === 'QuotaExceededError';
          resolve({ ok: false, quotaExceeded: isQuota });
        };
      } catch (txErr) {
        if (txErr?.name === 'InvalidStateError') {
          resetDbHandleIfCurrent(openPromise);
        }
        resolve({ ok: false, quotaExceeded: txErr?.name === 'QuotaExceededError' });
      }
    });
  }

  async function putMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const writeEpoch = dbEpoch;
    const preFiltered = [];
    const incomingKeys = new Set();
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      const key = typeof item?.key === 'string'
        ? item.key
        : typeof item?.cacheKey === 'string'
          ? item.cacheKey
          : '';
      const zh = typeof item?.zh === 'string' ? item.zh : '';
      if (key && zh.trim()) {
        preFiltered.push({
          key,
          zh,
          explicitTs: Number.isFinite(item?.ts) ? item.ts : null
        });
        incomingKeys.add(key);
      }
    }
    if (preFiltered.length === 0) return true;

    for (const key of incomingKeys) {
      pendingTouches.delete(key);
    }
    if (pendingTouches.size === 0 && touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
    // Wait only for an in-flight flush to finish (never drain unrelated touches in a loop)
    if (activeFlushPromise) {
      await activeFlushPromise.catch(() => {});
    }
    if (writeEpoch !== dbEpoch) return false;
    for (const key of incomingKeys) {
      pendingTouches.delete(key);
    }
    if (pendingTouches.size === 0 && touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }

    const now = Date.now();
    const valid = preFiltered.map((item) => ({
      key: item.key,
      zh: item.zh,
      ts: item.explicitTs !== null ? item.explicitTs : now
    }));

    try {
      const openPromise = openDB();
      const db = await openPromise;
      if (writeEpoch !== dbEpoch) return false;
      const firstTry = await writeEntriesWithCap(db, openPromise, valid, writeEpoch);
      if (firstTry.ok) return true;
      if (firstTry.quotaExceeded && writeEpoch === dbEpoch) {
        const evicted = await evictOldestFraction(db, openPromise, 0.2);
        if (evicted && writeEpoch === dbEpoch) {
          const retry = await writeEntriesWithCap(db, openPromise, valid, writeEpoch);
          return retry.ok;
        }
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async function clear() {
    dbEpoch += 1;
    pendingTouches.clear();
    if (touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
    if (activeFlushPromise) {
      await activeFlushPromise.catch(() => {});
    }
    let openPromise = null;
    try {
      openPromise = openDB();
      const db = await openPromise;
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (txErr) {
          if (txErr?.name === 'InvalidStateError') {
            resetDbHandleIfCurrent(openPromise);
          }
          resolve();
        }
      });
    } catch (_) {
      // Graceful fallback
    }
    // Also remove any leftover legacy storage key if present
    try {
      if (chrome?.storage?.local) {
        await chrome.storage.local.remove(LEGACY_CACHE_KEY);
      }
    } catch (_) {}
  }

  async function stats() {
    if (activeStatsPromise) return activeStatsPromise;
    const holder = { promise: null };
    const run = (async () => {
      let openPromise = null;
      try {
        openPromise = openDB();
        const db = await openPromise;
        return await new Promise((resolve) => {
          let entries = 0;
          let bytes = 0;
          let settled = false;
          let tx = null;
          let timeoutId = null;

          const finish = (result = { entries, bytes }) => {
            if (settled) return;
            settled = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            resolve(result);
          };

          const accumulateRecord = (rec) => {
            entries += 1;
            if (rec) {
              const kLen = typeof rec.key === 'string' ? rec.key.length : 0;
              const zLen = typeof rec.zh === 'string' ? rec.zh.length : 0;
              bytes += kLen + zLen * 2 + 24;
            }
          };

          timeoutId = setTimeout(() => {
            try { tx?.abort?.(); } catch (_) {}
            finish({ entries, bytes });
          }, STATS_TIMEOUT_MS);

          try {
            tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);

            if (typeof store.getAll === 'function' && typeof IDBKeyRange !== 'undefined') {
              let hasLastKey = false;
              let lastKey = null;
              const nextBatch = () => {
                if (settled) return;
                try {
                  const range = hasLastKey ? IDBKeyRange.lowerBound(lastKey, true) : null;
                  const batchReq = store.getAll(range, STATS_BATCH_SIZE);
                  batchReq.onsuccess = () => {
                    if (settled) return;
                    try {
                      const list = Array.isArray(batchReq.result) ? batchReq.result : [];
                      const prevKey = lastKey;
                      const hadPrevKey = hasLastKey;
                      for (const rec of list) {
                        accumulateRecord(rec);
                        if (rec && rec.key !== undefined) {
                          lastKey = rec.key;
                          hasLastKey = true;
                        }
                      }
                      if (
                        list.length >= STATS_BATCH_SIZE &&
                        hasLastKey &&
                        (!hadPrevKey || lastKey !== prevKey)
                      ) {
                        nextBatch();
                      }
                    } catch (_) {}
                  };
                  batchReq.onerror = (e) => {
                    try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
                  };
                } catch (_) {}
              };
              nextBatch();
            } else {
              const cursorReq = store.openCursor();
              cursorReq.onsuccess = () => {
                try {
                  const cursor = cursorReq.result;
                  if (cursor) {
                    accumulateRecord(cursor.value);
                    cursor.continue();
                  }
                } catch (_) {}
              };
            }

            tx.oncomplete = () => finish({ entries, bytes });
            tx.onerror = () => finish({ entries, bytes });
            tx.onabort = () => finish({ entries, bytes });
          } catch (txErr) {
            if (txErr?.name === 'InvalidStateError') {
              resetDbHandleIfCurrent(openPromise);
            }
            finish({ entries: 0, bytes: 0 });
          }
        });
      } catch (_) {
        return { entries: 0, bytes: 0 };
      } finally {
        if (activeStatsPromise === holder.promise) {
          activeStatsPromise = null;
        }
      }
    })();
    holder.promise = run;
    activeStatsPromise = run;
    return run;
  }

  async function migrateFromLegacyStorage() {
    if (migrationPromise) return migrationPromise;
    const holder = { promise: null };
    const run = (async () => {
      try {
        if (!chrome?.storage?.local) return 0;
        const data = await chrome.storage.local.get(LEGACY_CACHE_KEY);
        const legacy = data?.[LEGACY_CACHE_KEY];
        if (!legacy || typeof legacy !== 'object') return 0;

        const entries = [];
        for (const [key, val] of Object.entries(legacy)) {
          if (key && val && typeof val.zh === 'string' && val.zh.trim()) {
            entries.push({
              key,
              zh: val.zh,
              ts: Number.isFinite(val.t) ? val.t : Date.now()
            });
          }
        }

        if (entries.length === 0) {
          await chrome.storage.local.remove(LEGACY_CACHE_KEY);
          return 0;
        }

        const ok = await putMany(entries);
        if (ok) {
          await chrome.storage.local.remove(LEGACY_CACHE_KEY);
          return entries.length;
        }
        if (migrationPromise === holder.promise) {
          migrationPromise = null;
        }
        return 0;
      } catch (_) {
        if (migrationPromise === holder.promise) {
          migrationPromise = null;
        }
        return 0;
      }
    })();
    holder.promise = run;
    migrationPromise = run;
    return run;
  }

  globalThis.KCTCacheDB = {
    DB_NAME,
    STORE_NAME,
    MAX_ENTRIES,
    getMany,
    putMany,
    clear,
    stats,
    migrateFromLegacyStorage
  };
})();
