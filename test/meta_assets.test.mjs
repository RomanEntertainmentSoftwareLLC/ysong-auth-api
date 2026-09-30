import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMetaAssetSelection, metaAssetInventory } from '../src/promotion/meta-assets.mjs';

const connection={id:'connection',pageId:'page',pageName:'Artist',tasks:['CREATE_CONTENT'],instagramUserId:'ig',instagramUsername:'artist'};
const account={id:'123',graphId:'act_123',name:'Artist Ads',business:{id:'business',name:'Artist Business'},currency:'USD',timezone:'America/New_York',accountStatus:1,disableReason:0};
const pixel={id:'456',name:'Artist Pixel'};

test('inventory models authorized asset references without credentials or billing instruments',()=>{
  const inventory=metaAssetInventory({connections:[{...connection,pageAccessToken:'secret'}],adAccounts:[{...account,paymentCredentials:'secret'}],pixels:[pixel],datasets:[{id:'789',name:'Future Dataset'}],selectedAdAccountId:'123'});
  assert.deepEqual(inventory.businesses,[{id:'business',name:'Artist Business'}]);
  assert.deepEqual(inventory.pages[0].instagramIdentity,{id:'ig',username:'artist'});
  assert.deepEqual(inventory.dataSources,[{type:'pixel',id:'456',name:'Artist Pixel',adAccountId:'123'},{type:'dataset',id:'789',name:'Future Dataset',adAccountId:'123'}]);
  assert.equal(inventory.billingProvider,'meta');
  assert.equal(JSON.stringify(inventory).includes('secret'),false);
});

test('selection binds business, ad account, Page, Instagram identity, and Pixel',()=>{
  assert.deepEqual(assertMetaAssetSelection({connection,account,pixel,adAccountId:'123',pixelId:'456'}),{
    connectionId:'connection',businessId:'business',adAccountId:'123',pageId:'page',instagramUserId:'ig',pixelId:'456',billingProvider:'meta',
  });
  assert.throws(()=>assertMetaAssetSelection({connection,account:null,adAccountId:'999'}),/meta_ad_account_unavailable/);
  assert.throws(()=>assertMetaAssetSelection({connection,account,pixel:null,adAccountId:'123',pixelId:'456'}),/meta_pixel_unavailable/);
});
