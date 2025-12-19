/**
 * OfflineManager V7 - De "Snapshot" Editie
 * Past het advies toe: Gebruikt een onafhankelijk record voor de outbox.
 */
import DataGateway from './datagateway.js';

export default class OfflineManager {
  constructor(baseUrl, clientId, appName) {
    this.appName = appName;
    this.gateway = new DataGateway(baseUrl, clientId, appName);
    this.db = new Dexie(`AppCache_${appName}_${clientId}`);
    
    this.db.version(8).stores({ 
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
   * Slaat een document op met een gegarandeerde snapshot voor de outbox.
   */
  async saveSmartDocument(collectionName, data) {
    // STAP 1: Maak een harde kopie (snapshot) van de data.
    // Dit voorkomt dat wijzigingen in de UI later de outbox-payload verpesten.
    const record = JSON.parse(JSON.stringify(data));
    
    // Bepaal de actie op basis van het aanwezige _id in het record
    const hasServerId = record._id && typeof record._id === 'string' && record._id.length > 5;
    const action = hasServerId ? 'PUT' : 'POST';

    // STAP 2: Optimistic UI (Lokaal in Dexie)
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

    // STAP 3: Outbox vullen met het GEGEVENS-RECORD (de snapshot)
    // Hierdoor is het _id gegarandeerd aanwezig voor de gateway.saveDocument()
    await this.db.outbox.add({
      action: action,
      collection: collectionName,
      payload: record, // <--- Dit is de cruciale fix
      timestamp: Date.now()
    });

    if (navigator.onLine) {
      this.syncOutbox();
    }

    return record;
  }

  /**
   * Verwerkt de outbox.
   */
  async syncOutbox() {
    if (!navigator.onLine) return;

    const items = await this.db.outbox.orderBy('id').toArray();
    if (items.length === 0) return;

    for (const item of items) {
      try {
        // Gebruik de payload direct uit de outbox (dit is ons 'record')
        let finalPayload = item.payload;

        // Binaire conversie indien nodig
        for (const key in finalPayload) {
          if (finalPayload[key] && (finalPayload[key] instanceof File || finalPayload[key] instanceof Blob)) {
            finalPayload[key] = await this._blobToBase64(finalPayload[key]);
          }
        }

        // De Gateway.saveDocument detecteert nu feilloos PUT of POST dankzij het record
        const response = await this.gateway.saveDocument(item.collection, finalPayload);
        
        // Koppel ID als het een nieuwe lijst was
        if (item.action === 'POST' && response && response._id) {
          await this._linkServerId(item.collection, item.payload, response._id);
        }

        await this.db.outbox.delete(item.id);

      } catch (err) {
        console.error(`[Sync Fout] Mislukt in ${item.collection}:`, err);
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
