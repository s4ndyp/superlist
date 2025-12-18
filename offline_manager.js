/**
 * OfflineManager V4 - Samengevoegd & Robuust
 * Beheert de lokale Dexie database, binaire bijlagen, Smart Clear en slimme ID-koppeling.
 */
import DataGateway from './datagateway.js';

export default class OfflineManager {
  /**
   * @param {string} baseUrl - De URL van de API Gateway.
   * @param {string} clientId - De unieke ID van de gebruiker.
   * @param {string} appName - De naam van de applicatie.
   */
  constructor(baseUrl, clientId, appName) {
    this.appName = appName;
    this.gateway = new DataGateway(baseUrl, clientId, appName);
    
    // Unieke database per app en gebruiker
    this.db = new Dexie(`AppCache_${appName}_${clientId}`);
    
    // Schema definitie - Versie 5 voor maximale stabiliteit
    this.db.version(5).stores({
      data: "++id, collection, _id", 
      outbox: "++id, action, collection, payload"
    });
  }

  /**
   * Hulpmethode om binaire bestanden (Blob/File) om te zetten naar Base64.
   * @private
   */
  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Slaat een document intelligent op.
   * Optimistic UI: eerst lokaal, dan in de wachtrij.
   */
  async saveSmartDocument(collectionName, data) {
    // We maken een kopie om te voorkomen dat we het originele object aanpassen
    const record = JSON.parse(JSON.stringify(data));
    const serverId = record._id || null;
    const action = serverId ? 'PUT' : 'POST';

    // 1. Optimistic UI: Zoek of het item al lokaal bestaat om te updaten in de cache
    if (serverId) {
      const existing = await this.db.data
        .where({ collection: collectionName, _id: serverId })
        .first();
      
      if (existing) {
        await this.db.data.update(existing.id, { ...record, collection: collectionName });
      } else {
        await this.db.data.add({ ...record, collection: collectionName, _id: serverId });
      }
    } else {
      // Nieuw item: we slaan het op zonder _id, Dexie genereert een lokale 'id'
      await this.db.data.add({ ...record, collection: collectionName });
    }

    // 2. Voeg toe aan de outbox
    await this.db.outbox.add({
      action: action,
      collection: collectionName,
      payload: record,
      timestamp: Date.now()
    });

    // 3. Probeer te synchroniseren als we online zijn
    if (navigator.onLine) {
      this.syncOutbox();
    }

    return record;
  }

  /**
   * Synchroniseert de outbox. Nu robuust: stopt niet bij één fout.
   */
  async syncOutbox() {
    if (!navigator.onLine) return;

    const items = await this.db.outbox.orderBy('id').toArray();
    if (items.length === 0) return;

    console.log(`[Sync] Verwerken van ${items.length} acties voor ${this.appName}...`);

    for (const item of items) {
      try {
        let finalPayload = JSON.parse(JSON.stringify(item.payload));

        // Converteer bijlagen indien aanwezig
        for (const key in finalPayload) {
          if (finalPayload[key] && (finalPayload[key] instanceof File || finalPayload[key] instanceof Blob)) {
            finalPayload[key] = await this._blobToBase64(finalPayload[key]);
          }
        }

        if (item.action === 'POST') {
          const response = await this.gateway.saveDocument(item.collection, finalPayload);
          // Cruciaal: koppel het nieuwe server-ID aan het lokale record
          if (response && response._id) {
            await this._linkServerId(item.collection, item.payload, response._id);
          }
        } 
        else if (item.action === 'PUT') {
          await this.gateway.updateDocument(item.collection, item.payload._id, finalPayload);
        }
        else if (item.action === 'DELETE') {
          await this.gateway.deleteDocument(item.collection, item.payload._id);
        }
        else if (item.action === 'CLEAR') {
          await this.gateway.clearCollection(item.collection);
        }

        // Bij succes verwijderen we de actie uit de outbox
        await this.db.outbox.delete(item.id);

      } catch (err) {
        console.error(`[Sync Fout] Item ${item.id} mislukt:`, err);
        // We gaan door naar het volgende item ipv de hele loop te stoppen
        continue; 
      }
    }
  }

  /**
   * Koppelt server-ID's terug aan lokale records die zojuist zijn aangemaakt.
   * @private
   */
  async _linkServerId(collectionName, originalPayload, newServerId) {
    // Zoek het lokale record dat nog geen _id heeft, maar wel overeenkomt op naam
    const localRecord = await this.db.data
      .where({ collection: collectionName })
      .filter(doc => !doc._id && (doc.name?.trim() === originalPayload.name?.trim()))
      .first();

    if (localRecord) {
      await this.db.data.update(localRecord.id, { _id: newServerId });
    }
  }

  /**
   * Haalt data op en filtert dubbele ID's voor de UI.
   */
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

  /**
   * Ververst de cache, maar is voorzichtig met ongesynchroniseerde data.
   */
  async refreshCache(collectionName) {
    try {
      const freshData = await this.gateway.getCollection(collectionName);
      
      const outboxItems = await this.db.outbox.where({ collection: collectionName }).toArray();
      const pendingIds = new Set(outboxItems.map(i => i.payload._id).filter(id => id));
      const pendingNewNames = new Set(outboxItems.filter(i => !i.payload._id).map(i => i.payload.name));

      // Verwijder alleen data die NIET in de outbox staat te wachten
      await this.db.data.where({ collection: collectionName })
        .filter(doc => {
            if (!doc._id) return !pendingNewNames.has(doc.name);
            return !pendingIds.has(doc._id);
        })
        .delete();
      
      const taggedData = freshData.map(d => ({ ...d, collection: collectionName }));
      await this.db.data.bulkPut(taggedData);

    } catch (err) {
      console.warn("[Cache] Refresh mislukt (waarschijnlijk offline):", err);
    }
  }

  /**
   * Wist een hele collectie via Smart Clear.
   */
  async clearSmartCollection(collectionName) {
    await this.db.data.where({ collection: collectionName }).delete();
    await this.db.outbox.add({
      action: 'CLEAR',
      collection: collectionName,
      timestamp: Date.now()
    });

    if (navigator.onLine) {
      this.syncOutbox();
    }
  }
}
