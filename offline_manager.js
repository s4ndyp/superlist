/**
 * OfflineManager V5 - FIX: Correcte PUT/UPDATE afhandeling
 */
import DataGateway from './datagateway.js';

export default class OfflineManager {
  constructor(baseUrl, clientId, appName) {
    this.appName = appName;
    this.gateway = new DataGateway(baseUrl, clientId, appName);
    this.db = new Dexie(`AppCache_${appName}_${clientId}`);
    
    this.db.version(6).stores({ // Versie 6 voor de PUT fix
      data: "++id, collection, _id", 
      outbox: "++id, action, collection, payload"
    });
  }

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Slaat een document op. Kiest tussen POST (nieuw) en PUT (bestaand).
   */
  async saveSmartDocument(collectionName, data) {
    const record = JSON.parse(JSON.stringify(data));
    // Check of er een _id aanwezig is (string van MongoDB)
    const hasServerId = record._id && typeof record._id === 'string' && record._id.length > 5;
    const action = hasServerId ? 'PUT' : 'POST';

    // 1. Optimistic UI: Update lokale cache
    if (hasServerId) {
      const existing = await this.db.data
        .where({ collection: collectionName, _id: record._id })
        .first();
      
      if (existing) {
        await this.db.data.update(existing.id, { ...record, collection: collectionName });
      } else {
        await this.db.data.add({ ...record, collection: collectionName, _id: record._id });
      }
    } else {
      await this.db.data.add({ ...record, collection: collectionName });
    }

    // 2. Outbox: Zet de actie in de wachtrij
    await this.db.outbox.add({
      action: action,
      collection: collectionName,
      payload: record,
      timestamp: Date.now()
    });

    if (navigator.onLine) {
      this.syncOutbox();
    }

    return record;
  }

  /**
   * Synchroniseert outbox. Verwerkt nu correct POST, PUT en DELETE.
   */
  async syncOutbox() {
    if (!navigator.onLine) return;

    const items = await this.db.outbox.orderBy('id').toArray();
    if (items.length === 0) return;

    for (const item of items) {
      try {
        let finalPayload = JSON.parse(JSON.stringify(item.payload));

        // Binaire conversie
        for (const key in finalPayload) {
          if (finalPayload[key] && (finalPayload[key] instanceof File || finalPayload[key] instanceof Blob)) {
            finalPayload[key] = await this._blobToBase64(finalPayload[key]);
          }
        }

        if (item.action === 'POST') {
          const response = await this.gateway.saveDocument(item.collection, finalPayload);
          if (response && response._id) {
            await this._linkServerId(item.collection, item.payload, response._id);
          }
        } 
        else if (item.action === 'PUT') {
          // HIER ZAT DE FOUT: Nu roepen we expliciet de update aan
          const docId = finalPayload._id;
          await this.gateway.updateDocument(item.collection, docId, finalPayload);
        }
        else if (item.action === 'DELETE') {
          await this.gateway.deleteDocument(item.collection, item.payload._id);
        }
        else if (item.action === 'CLEAR') {
          await this.gateway.clearCollection(item.collection);
        }

        await this.db.outbox.delete(item.id);

      } catch (err) {
        console.error(`[Sync Fout] ${item.action} op ${item.collection} mislukt:`, err);
        continue; 
      }
    }
  }

  async _linkServerId(collectionName, originalPayload, newServerId) {
    const localRecord = await this.db.data
      .where({ collection: collectionName })
      .filter(doc => !doc._id && (doc.name?.trim() === originalPayload.name?.trim()))
      .first();

    if (localRecord) {
      await this.db.data.update(localRecord.id, { _id: newServerId });
    }
  }

  async getSmartCollection(collectionName) {
    let localData = await this.db.data.where({ collection: collectionName }).toArray();
    const seen = new Set();
    localData = localData.filter(item => {
      const identifier = item._id || `local-${item.id}`;
      if (seen.has(identifier)) return false;
      seen.add(identifier);
      return true;
    });

    if (navigator.onLine) {
      this.refreshCache(collectionName);
    }
    return localData;
  }

  async refreshCache(collectionName) {
    try {
      const freshData = await this.gateway.getCollection(collectionName);
      const outboxItems = await this.db.outbox.where({ collection: collectionName }).toArray();
      const pendingIds = new Set(outboxItems.map(i => i.payload._id).filter(id => id));
      const pendingNewNames = new Set(outboxItems.filter(i => !i.payload._id).map(i => i.payload.name));

      await this.db.data.where({ collection: collectionName })
        .filter(doc => {
            if (!doc._id) return !pendingNewNames.has(doc.name);
            return !pendingIds.has(doc._id);
        })
        .delete();
      
      const taggedData = freshData.map(d => ({ ...d, collection: collectionName }));
      await this.db.data.bulkPut(taggedData);
    } catch (err) {
      console.warn("[Cache] Refresh mislukt:", err);
    }
  }

  async clearSmartCollection(collectionName) {
    await this.db.data.where({ collection: collectionName }).delete();
    await this.db.outbox.add({ action: 'CLEAR', collection: collectionName });
    if (navigator.onLine) this.syncOutbox();
  }
}
