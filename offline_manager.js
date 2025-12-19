/**
 * OfflineManager V6 - Universele Save (POST/PUT via saveDocument)
 */
import DataGateway from './datagateway.js';

export default class OfflineManager {
  constructor(baseUrl, clientId, appName) {
    this.appName = appName;
    // De gateway heeft een smart saveDocument functie
    this.gateway = new DataGateway(baseUrl, clientId, appName);
    this.db = new Dexie(`AppCache_${appName}_${clientId}`);
    
    this.db.version(7).stores({ 
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
   * Slaat een document op. De gateway bepaalt of het POST of PUT is.
   */
  async saveSmartDocument(collectionName, data) {
    const record = JSON.parse(JSON.stringify(data));
    const hasServerId = record._id && typeof record._id === 'string' && record._id.length > 5;
    
    // We houden de action in de outbox nog even bij voor logging/debugging,
    // maar we gebruiken voor beide saveDocument.
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

    // 2. Outbox: Zet in de wachtrij
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
   * Synchroniseert outbox. Gebruikt gateway.saveDocument voor zowel POST als PUT.
   */
  async syncOutbox() {
    if (!navigator.onLine) return;

    const items = await this.db.outbox.orderBy('id').toArray();
    if (items.length === 0) return;

    for (const item of items) {
      try {
        let finalPayload = JSON.parse(JSON.stringify(item.payload));

        // Binaire conversie voor afbeeldingen/bestanden
        for (const key in finalPayload) {
          if (finalPayload[key] && (finalPayload[key] instanceof File || finalPayload[key] instanceof Blob)) {
            finalPayload[key] = await this._blobToBase64(finalPayload[key]);
          }
        }

        // POST en PUT gebruiken nu beide gateway.saveDocument
        if (item.action === 'POST' || item.action === 'PUT') {
          const response = await this.gateway.saveDocument(item.collection, finalPayload);
          
          // Als het een nieuwe POST was, koppelen we het nieuwe _id aan de lokale cache
          if (item.action === 'POST' && response && response._id) {
            await this._linkServerId(item.collection, item.payload, response._id);
          }
        } 
        else if (item.action === 'DELETE') {
          await this.gateway.deleteDocument(item.collection, item.payload._id);
        }
        else if (item.action === 'CLEAR') {
          await this.gateway.clearCollection(item.collection);
        }

        // Verwijder de actie uit de outbox na succesvolle gateway aanroep
        await this.db.outbox.delete(item.id);

      } catch (err) {
        console.error(`[Sync Fout] Fout bij ${item.action} in ${item.collection}:`, err);
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
