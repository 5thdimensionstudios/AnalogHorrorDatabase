let database = {
  series: [],
  characters: [],
  episodes: []
};

exports.handler = async (event) => {

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      body: JSON.stringify(database)
    };
  }

  if (event.httpMethod === "POST") {
    database = JSON.parse(event.body);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true })
    };
  }

};
