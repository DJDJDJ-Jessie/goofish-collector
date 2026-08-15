(function () {
  'use strict';

  // The catalog is shared by the side panel, the service worker and the
  // offscreen workbook builder.  Keeping field ids stable lets a saved
  // template survive label changes and makes the exported column order
  // explicit instead of relying on object enumeration order.
  const product = [
    { id: 'itemId', label: '商品ID', group: '商品信息', defaultSelected: true },
    { id: 'itemUrl', label: '商品链接', group: '商品信息', defaultSelected: true },
    { id: 'mainImageName', label: '主图文件名', group: '商品图片', defaultSelected: true },
    { id: 'images', label: '商品图片', group: '商品图片', defaultSelected: true },
    { id: 'title', label: '商品标题', group: '商品信息', defaultSelected: false },
    { id: 'description', label: '商品文案', group: '商品信息', defaultSelected: true },
    { id: 'viewCount', label: '浏览数', group: '互动数据', defaultSelected: true },
    { id: 'wantCount', label: '想要数', group: '互动数据', defaultSelected: true },
    { id: 'price', label: '价格', group: '商品信息', defaultSelected: true },
    { id: 'category', label: '类目', group: '商品信息', defaultSelected: true },
    { id: 'sellerName', label: '店铺名称', group: '店铺信息', defaultSelected: true },
    { id: 'sellerUrl', label: '卖家账号页', group: '店铺信息', defaultSelected: true },
    { id: 'sellerLocation', label: '卖家地区', group: '店铺信息', defaultSelected: true },
    { id: 'sellerFollowers', label: '粉丝数', group: '店铺信息', defaultSelected: true },
    { id: 'sellerFollowing', label: '关注数', group: '店铺信息', defaultSelected: true },
    { id: 'sellerProductCount', label: '卖家商品数', group: '店铺信息', defaultSelected: true },
    { id: 'sellerIntro', label: '店铺简介', group: '店铺信息', defaultSelected: true },
    { id: 'storeDuration', label: '开店时长', group: '详情页卖家字段', defaultSelected: true },
    { id: 'itemGoodRate', label: '商品好评率', group: '详情页卖家字段', defaultSelected: true },
    { id: 'sellerReviewCount', label: '店铺评价数', group: '店铺信息', defaultSelected: true },
    { id: 'imageStatus', label: '图片状态', group: '商品图片', defaultSelected: false },
    { id: 'sourcePage', label: '来源页面', group: '采集信息', defaultSelected: false },
    { id: 'dataSource', label: '数据来源', group: '采集信息', defaultSelected: false },
    { id: 'collectedAt', label: '采集时间', group: '采集信息', defaultSelected: true }
  ];

  const storeProfile = [
    { id: 'sellerName', label: '店铺名称', group: '店铺资料', defaultSelected: true },
    { id: 'sellerUrl', label: '卖家账号页', group: '店铺资料', defaultSelected: true },
    { id: 'sellerLocation', label: '卖家地区', group: '店铺资料', defaultSelected: true },
    { id: 'sellerFollowers', label: '粉丝数', group: '店铺资料', defaultSelected: true },
    { id: 'sellerFollowing', label: '关注数', group: '店铺资料', defaultSelected: true },
    { id: 'sellerProductCount', label: '卖家商品数', group: '店铺资料', defaultSelected: true },
    { id: 'sellerIntro', label: '店铺简介', group: '店铺资料', defaultSelected: true },
    { id: 'sellerReviewCount', label: '店铺评价数', group: '店铺资料', defaultSelected: true },
    { id: 'collectedAt', label: '采集时间', group: '采集信息', defaultSelected: true },
    { id: 'sourcePage', label: '来源页面', group: '采集信息', defaultSelected: false },
    { id: 'reviewCountLoaded', label: '已采集评价数', group: '采集信息', defaultSelected: false }
  ];

  const storeReview = [
    { id: 'sellerName', label: '店铺名称', group: '评价归属', defaultSelected: true },
    { id: 'sellerUrl', label: '卖家账号页', group: '评价归属', defaultSelected: true },
    { id: 'reviewIndex', label: '评价序号', group: '评价内容', defaultSelected: true },
    { id: 'reviewer', label: '评价人', group: '评价内容', defaultSelected: true },
    { id: 'role', label: '身份', group: '评价内容', defaultSelected: true },
    { id: 'feedback', label: '评价内容', group: '评价内容', defaultSelected: true },
    { id: 'timeIp', label: '评价时间/地区', group: '评价内容', defaultSelected: true },
    { id: 'reviewImageCount', label: '评价图片数', group: '评价图片', defaultSelected: true },
    { id: 'reviewImageNames', label: '评价图片文件名', group: '评价图片', defaultSelected: true },
    { id: 'reviewImageStatus', label: '评价图片状态', group: '评价图片', defaultSelected: true },
    { id: 'reviewImages', label: '评价图片', group: '评价图片', defaultSelected: true },
    { id: 'reviewImageFailureUrl', label: '评价图片失败地址', group: '评价图片', defaultSelected: true },
    { id: 'reviewCollectedAt', label: '评价采集时间', group: '采集信息', defaultSelected: true }
  ];

  const fields = { product, storeProfile, storeReview };
  const defaults = Object.fromEntries(Object.entries(fields).map(([type, definitions]) => [
    type,
    definitions.filter(field => field.defaultSelected).map(field => field.id)
  ]));

  const catalog = {
    fields,
    defaults,
    get(type) {
      return Array.isArray(fields[type]) ? fields[type].slice() : [];
    },
    labels(type) {
      return Object.fromEntries((fields[type] || []).map(field => [field.id, field.label]));
    }
  };

  globalThis.XianyuFieldConfig = catalog;
})();
