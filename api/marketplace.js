const { route } = require('../lib/marketplace');
const { json, prepareResponse } = require('../lib/http');

module.exports = async function marketplace(request, response) {
  if (!prepareResponse(request, response)) return;
  if (!['GET','POST','PATCH'].includes(request.method)) return json(response,405,{error:'Method not allowed'});
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const data = await route(request,body);
    return json(response,request.method === 'POST' ? 201 : 200,{data});
  } catch (error) {
    const status = error.status || ({'23505':409,'23503':409,'23514':400,'22P02':400}[error.code] ?? 500);
    if (status === 500) console.error('Marketplace error', error);
    return json(response,status,{error:status === 500 ? 'Server error' : status === 409 && error.code === '23505' ? 'This email is already registered' : error.message});
  }
};
